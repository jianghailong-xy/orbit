package io.orbitd.android.directory

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.*
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.orbitd.android.OrbitApplication
import io.orbitd.android.R
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.cards.*
import io.orbitd.android.management.CodexSignInText
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.Origin
import io.orbitd.android.navigation.OrbitRoute
import io.orbitd.android.projects.LandingJobsSheet
import io.orbitd.android.projects.LandingRing
import io.orbitd.android.projects.OwnerStartSheet
import io.orbitd.android.projects.ProjectApi
import io.orbitd.android.projects.ProjectDoc
import io.orbitd.android.projects.ProjectDone
import io.orbitd.android.projects.ProjectLandingCardView
import io.orbitd.android.projects.ProjectPage
import io.orbitd.android.projects.ProjectPageState
import io.orbitd.android.projects.ProjectSettledCard
import io.orbitd.android.projects.RunSettings
import io.orbitd.android.projects.RequestedStartSheet
import io.orbitd.android.projects.StartProjectCopy
import io.orbitd.android.projects.StartSheetLoad
import io.orbitd.android.projects.failureReason
import io.orbitd.android.reader.LandingSessionCopy
import io.orbitd.android.taskprojects.canWrite
import io.orbitd.android.taskprojects.writable
import io.orbitd.android.ui.LocalOrbitColors
import io.orbitd.android.wiki.PageBar
import io.orbitd.android.wiki.WikiDate
import java.time.Instant
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonObject

// A05-6's row and A05-7's page (iOS SessionProjectPage.swift): a project in its coordinator's place in a workspace's list, and the
// project's own sessions page that row opens.

/** The project in its coordinator's place, with a session row's two lines (iOS `SessionProjectRowView`): its name, what its sessions
 * are doing — waiting on you, running, a background job — and when; then its progress and what the row says. A tap opens the
 * project's sessions; ⋯ the row's menu. */
@Composable
internal fun SessionProjectRowView(row: SessionProjectRow, onOpen: () -> Unit, onOptions: () -> Unit) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val words = SessionProjectCopy.statusWords(row)
    ListItem(
        headlineContent = {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(row.title, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                ProjectIndicator(row.indicator)
                // An instant this clock cannot read draws no time at all.
                (row.lastTurnAt ?: row.createdAt)?.let { WikiDate.relative(it, Instant.now()) }?.let {
                    Text(it, style = MaterialTheme.typography.labelMedium, color = muted, maxLines = 1, softWrap = false)
                }
            }
        },
        supportingContent = {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                ProjectProgressChip(row.taskCounts, row.runningCount, row.status)
                // The line, the sentence alone (iOS `SessionProjectRowView`, the web's project row).
                Text(row.line.text,
                    Modifier.testTag("project-row-line"), maxLines = 1, overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.bodyMedium, color = lineColor(row.line.tone))
            }
        },
        trailingContent = { IconButton(onOptions) { Icon(painterResource(R.drawable.ic_more), "Options for ${row.title}") } },
        modifier = Modifier.clickable(role = Role.Button, onClick = onOpen).semantics { stateDescription = words }.testTag("project-row:${row.projectId}"))
}

@Composable
private fun lineColor(tone: SessionLine.Tone): Color = when (tone) {
    SessionLine.Tone.APPROVAL, SessionLine.Tone.WARNING -> LocalOrbitColors.current.needsYou
    SessionLine.Tone.RUNNING -> MaterialTheme.colorScheme.primary
    else -> MaterialTheme.colorScheme.onSurfaceVariant
}

/** Waiting on you: the amber dot; a member running: the spinner; only a background job left: the terminal mark, breathing. */
@Composable
private fun ProjectIndicator(indicator: SessionProjectRow.Indicator?) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    when (indicator) {
        SessionProjectRow.Indicator.NEEDS_YOU -> Box(Modifier.size(7.dp).background(LocalOrbitColors.current.needsYou, CircleShape).testTag("project-row-needs-you"))
        SessionProjectRow.Indicator.RUNNING -> CircularProgressIndicator(Modifier.size(12.dp).testTag("project-row-running"), color = muted, strokeWidth = 1.5.dp)
        SessionProjectRow.Indicator.JOBS -> {
            val breath by rememberInfiniteTransition(label = "jobs").animateFloat(0.35f, 1f, infiniteRepeatable(tween(1_100), RepeatMode.Reverse), label = "jobs")
            Icon(painterResource(R.drawable.ic_terminal), null, Modifier.size(14.dp).alpha(breath).testTag("project-row-jobs"), tint = muted)
        }
        null -> Unit
    }
}

/** The progress chip at the head of the second line: the mini bar and "done/total", or — for a project the sidebar did not list —
 * its status word. Green once the project is done. */
@Composable
internal fun ProjectProgressChip(counts: ProjectTaskCounts?, running: Int, status: String) {
    val ink = if (status == "DONE") LocalOrbitColors.current.success else MaterialTheme.colorScheme.onSurfaceVariant
    Row(Modifier.background(ink.copy(alpha = 0.14f), RoundedCornerShape(5.dp)).padding(horizontal = 6.dp, vertical = 2.dp).testTag("project-progress-chip"),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        if (counts != null) ProjectProgressBar(counts, running, Modifier.width(26.dp))
        Text(counts?.let { SessionProjectCopy.progress(it.done, it.total) } ?: SessionProjectCopy.statusLabel(status),
            style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold, color = ink, maxLines = 1, softWrap = false)
    }
}

/** Done, running and failed out of the total, over a grey track (iOS `SessionProjectProgressBar`). */
@Composable
internal fun ProjectProgressBar(counts: ProjectTaskCounts, running: Int, modifier: Modifier = Modifier) {
    Row(modifier.height(4.dp).clip(RoundedCornerShape(50)).background(MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.3f))
        .clearAndSetSemantics {}) {
        if (counts.total > 0) {
            listOf(counts.done to LocalOrbitColors.current.success, running to MaterialTheme.colorScheme.primary, counts.failed to MaterialTheme.colorScheme.error)
                .filter { it.first > 0 }.forEach { (n, color) -> Box(Modifier.weight(n.toFloat()).fillMaxHeight().background(color)) }
            (counts.total - counts.done - running - counts.failed).takeIf { it > 0 }?.let { Spacer(Modifier.weight(it.toFloat())) }
        }
    }
}

/** A project row's menu (iOS `SessionProjectRowActions`): the session its line speaks for, the project's sessions, its page — then
 * Pin and Move, which act on its coordinator. A project has no completion, sharing or deletion of its own. */
@Composable
internal fun ProjectRowMenu(row: SessionProjectRow, fresh: Boolean, close: () -> Unit, openSession: (String) -> Unit, openSessions: () -> Unit,
    openProject: () -> Unit, pin: (DirectorySession) -> Unit, move: (DirectorySession) -> Unit) {
    AlertDialog(onDismissRequest = close, title = { Text(row.title) }, modifier = Modifier.testTag("project-row-menu"),
        confirmButton = { TextButton(onClick = close) { Text("Close") } },
        text = {
            Column(Modifier.heightIn(max = 480.dp).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                val session = (row.target as? SessionProjectRow.Target.Session)?.id
                ActionButton(SessionProjectCopy.openSession, session != null) { close(); session?.let(openSession) }
                ActionButton(SessionProjectCopy.sessions, true) { close(); openSessions() }
                ActionButton(SessionProjectCopy.openProject, true) { close(); openProject() }
                HorizontalDivider()
                val coordinator = row.coordinator
                ActionButton(if (coordinator?.pinnedAt != null) SessionProjectCopy.unpin else SessionProjectCopy.pin, coordinator != null && fresh) {
                    close(); coordinator?.let(pin)
                }
                ActionButton(SessionProjectCopy.move, coordinator != null && fresh) { close(); coordinator?.let(move) }
            }
        })
}

/** What the page has read: its members and when, the landing read, and — while nobody has started the project — its open items. */
private class ProjectSessionsState(initial: List<DirectorySession>) {
    var members by mutableStateOf(initial.filterNot { it.isLanding })
    /** The landing sessions the same read carries (`includeLanding=1`): what the Landings row counts, never the page's timeline. */
    var landings by mutableStateOf(initial.filter { it.isLanding })
    /** The Completed members as last read: what a poll takes them from. */
    var completed: List<DirectorySession> = initial.filter { it.effectiveLifecycleState != "OPEN" }
    /** When the members were last read; null until a read has answered. */
    var readAt: Instant? = null
    var loading by mutableStateOf(true)
    var error by mutableStateOf<String?>(null)
    var integration by mutableStateOf<JsonObject?>(null)
    var integrationReadAt by mutableStateOf<Instant?>(null)
    var integrationReadFailed by mutableStateOf(false)
    var openItems by mutableStateOf<JsonObject?>(null)
    /** The project document, while the project may be done: what the page's ending is drawn from (`ProjectDone.drawsEnding`). */
    var done by mutableStateOf<JsonObject?>(null)
}

private enum class StartSheet { ASKED, OWN }

/**
 * A project's sessions (iOS `SessionProjectPage`, A05-7), pushed over the list it was opened from, or the root of the drawer's project
 * row: its progress — with the start while nobody has started the project — then the landing in flight as a card of its own (A11-11),
 * then the merge into main (A11-9) while there is one to show, then its coordinator, then the one Landings row that opens the project's
 * Landings window (owner 2026-10-27), then every other member by recency, Open and Completed together. No search and no Pinned: it
 * lists one project's sessions. A member opens over this page, and the workspace the page was entered from stays the one beneath it.
 * Members, the landing, the merge and the start are each read every 4 s; the progress comes from `GET /projects/sidebar`.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun SessionProjectPage(app: OrbitApplication, handle: SessionHandle, route: OrbitRoute, data: DirectoryData, api: DirectoryApi,
    revision: Long, open: (OrbitRoute) -> Unit) {
    val projectId = route.id ?: return
    val projects = remember(handle) { ProjectApi(app.session, handle) { app.canWrite(handle) } }
    // A new page opens on what the app already holds of the project — every workspace's Open and Completed rows — and its read
    // replaces them when it answers.
    val state = remember(handle, projectId) {
        ProjectSessionsState(SessionProjectMembers.members(projectId, data.sessions["open"].orEmpty() + data.sessions["completed"].orEmpty()))
    }
    val trashing = app.trashing
    val hidden by trashing.ids.collectAsState()
    val sidebar by rememberProjectSidebar(api, revision)
    val project = sidebar.firstOrNull { it.text("id")?.let(SessionProjectGrouping::key) == SessionProjectGrouping.key(projectId) }
    val currentData by rememberUpdatedState(data)
    val currentProject by rememberUpdatedState(project)
    val scope = rememberCoroutineScope()
    var now by remember { mutableStateOf(Instant.now()) }
    var refreshing by remember { mutableStateOf(false) }
    var action by remember { mutableStateOf<DirectoryDialog?>(null) }
    var startSheet by remember { mutableStateOf<StartSheet?>(null) }
    var showsJobs by remember { mutableStateOf(false) }
    // The merge into main (iOS `ProjectMergeModel`): this project's candidate and merges, never another project's.
    val merge = remember(handle, projectId) { ProjectMergeModel(projects, projectId) }
    // Hosted here rather than by the card, so a poll redrawing it cannot dismiss what the owner is reading.
    var promotionReview by remember(projectId) { mutableStateOf<String?>(null) }

    // `includeLanding=1` (LS6): the page's read carries the project's LANDING rows beside its conversations, which is what the
    // Landings row counts. No other list asks for them, so no other list grows a row it cannot place.
    suspend fun read(view: String): List<DirectorySession> =
        api.read(listOf("sessions"), ListSerializer(DirectorySession.serializer()), listOf("view" to view, "projectId" to projectId, "includeLanding" to "1"))
    /** Both lists; an older server may ignore projectId, so only the project's members are kept, and never one in Trash — nor one on
     * its way there (A05-9). A read that a session's release overlapped may be from before that session's move, so it is read again. */
    suspend fun loadMembers() {
        state.loading = true
        try {
            var rows: List<DirectorySession>
            do {
                val releases = trashing.releases
                rows = coroutineScope { val open = async { read("open") }; val completed = async { read("completed") }; open.await() + completed.await() }
            } while (trashing.releases != releases)
            val kept = trashing.without(rows) { it.id }
            state.members = SessionProjectMembers.members(projectId, kept)
            state.landings = SessionProjectMembers.landings(projectId, kept)
            state.completed = kept.filter { it.effectiveLifecycleState != "OPEN" }
            state.readAt = Instant.now(); state.error = null
        } catch (cancel: CancellationException) { throw cancel }
        catch (failure: Exception) { state.error = CodexSignInText.sentence(failureReason(failure)) }
        finally { state.loading = false }
    }
    /** One poll that asks for neither list again unless something moved: the Open members are the app's Open list's, kept current by
     * its control stream; the Completed ones are read again when an Open member left that list, or a minute after the last read. A
     * Completed read that a release overlapped is dropped, and the next poll reads again. */
    suspend fun pollMembers() {
        val readAt = state.readAt
        if (state.error != null || readAt == null || !currentData.ready) return loadMembers()
        val openList = currentData.sessions["open"].orEmpty()
        val (members, moved) = SessionProjectMembers.poll(trashing.without(state.members) { it.id }, projectId, openList,
            trashing.without(state.completed) { it.id })
        if (members != state.members) state.members = members
        if (!moved && Instant.now().toEpochMilli() - readAt.toEpochMilli() < SessionProjectMembers.completedRefreshMs) return
        try {
            val releases = trashing.releases
            val rows = read("completed")
            if (trashing.releases != releases) return
            val completed = trashing.without(rows) { it.id }
            state.completed = completed; state.readAt = Instant.now()
            val next = SessionProjectMembers.members(projectId, currentData.sessions["open"].orEmpty() + completed)
            if (next != state.members) state.members = next
            // The refresh is also what keeps a settled landing's summary current; the landing rows the poll does not re-read are
            // held as they were last read, never counted as members nor dropped by a member read that did not carry them (LS6).
            state.landings = (SessionProjectMembers.landings(projectId, completed) + state.landings).distinctBy { it.id }
        } catch (cancel: CancellationException) { throw cancel }
        catch (failure: Exception) { state.error = CodexSignInText.sentence(failureReason(failure)) }
    }
    /** The landing line's read; a read that fails keeps the last answer and says it is stale. */
    suspend fun loadIntegration() {
        val view = try { projects.integration(projectId) } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { null }
        if (view != null) {
            state.integration = view; state.integrationReadAt = Instant.now(); state.integrationReadFailed = false
            // Each landing job's description, for its card in the Landings window to draw frozen when the server cannot be read
            // (A11-20 e).
            app.landingJobs.remember(handle, projectId, view)
        } else state.integrationReadFailed = true
    }
    /** The start row's read, while the sidebar says nobody has started the project. A read that fails keeps the last answer. */
    suspend fun loadStart() {
        val row = currentProject
        if (row?.text("status") != "OPEN" || ProjectDoc.started(row) != false) { state.openItems = null; return }
        val items = try { projects.openItems(projectId) } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { null }
        if (items != null) state.openItems = items
    }
    /** The ending's read (docs/mocks/project-done-sessions-page, owner decision 2026-10-10), while the page's project may be done:
     * the sidebar's rows are the Open projects, so a row that is not Open, or none at all, is that state. A project the row says is
     * Open reads nothing and keeps nothing; a read that fails keeps the last answer, as the landing line's does. */
    suspend fun loadDone() {
        val row = currentProject
        if (row?.text("status") == "OPEN") { state.done = null; return }
        val doc = try { projects.document(projectId) } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { null }
        if (doc != null) state.done = doc
    }
    LaunchedEffect(handle, projectId) {
        // A member on its way to Trash leaves the page on the press, wherever it was pressed, and what the page holds of it goes too
        // (iOS `hideTrashedSession`): once the move has settled nothing would take it out again.
        launch {
            var held = trashing.ids.value
            trashing.ids.collect { ids ->
                val gone = ids - held
                held = ids
                if (gone.isNotEmpty()) {
                    state.members = TrashingSessions.without(state.members, gone) { it.id }
                    state.completed = TrashingSessions.without(state.completed, gone) { it.id }
                }
            }
        }
        launch { loadMembers(); while (true) { delay(4_000); pollMembers() } }
        launch { while (true) { loadIntegration(); delay(4_000) } }
        launch { while (true) { merge.load(); delay(4_000) } }
        launch { while (true) { loadStart(); delay(4_000) } }
        launch { while (true) { loadDone(); delay(4_000) } }
        launch { while (true) { delay(1_000); now = Instant.now() } }
    }
    fun refresh() = scope.launch {
        refreshing = true
        try { coroutineScope { launch { loadMembers() }; launch { loadIntegration() }; launch { merge.load(force = true) }; launch { loadStart() }; launch { loadDone() } } }
        finally { refreshing = false }
    }
    // The project's page, over this one: back returns here.
    fun openProject() = open(OrbitRoute(Destination.PROJECT, projectId))
    /** One Retry of a job in flight, the landing card's and the jobs list's one door: the line read it answers is drawn at once; a
     * refusal comes back in the server's words. */
    suspend fun retryJob(jobId: String): String? =
        try { projects.retryJob(projectId, jobId)?.let { view -> state.integration = view; state.integrationReadAt = Instant.now(); state.integrationReadFailed = false }; null }
        catch (cancel: CancellationException) { throw cancel }
        catch (failure: Exception) { "${ProjectPage.landingRetryFailed} — ${failureReason(failure).trimEnd('.')}." }
    /** One of the timed-out merge card's doors — Re-run the check (J-T9) or Abandon (J-T10): the page's landing read and the
     *  candidate are read again when it answers; a refusal comes back in the server's words. */
    suspend fun landingDoor(press: suspend () -> Unit): String? =
        try { press(); coroutineScope { launch { loadIntegration() }; launch { merge.load(force = true) } }; null }
        catch (cancel: CancellationException) { throw cancel }
        catch (failure: Exception) { failureReason(failure) }

    val members = TrashingSessions.without(state.members, hidden) { it.id }
    val coordinator = members.firstOrNull { it.projectMembership?.isCoordinator == true }
    PageBar.Bind(route, project?.text("title") ?: members.firstOrNull()?.projectMembership?.projectTitle ?: "Project",
        // No count while no member is known yet: "0 sessions" would be a claim nobody checked.
        if (state.loading && members.isEmpty()) SessionProjectCopy.pageSubtitleLoading else SessionProjectCopy.pageSubtitle(members.size)) {
        IconButton(onClick = ::openProject, modifier = Modifier.testTag("project-sessions-open-project")) {
            Icon(painterResource(R.drawable.ic_grid), SessionProjectCopy.openProject)
        }
    }
    @Composable
    fun MemberRow(session: DirectorySession) {
        val view = if (session.effectiveLifecycleState == "COMPLETED") SessionView.COMPLETED else SessionView.OPEN
        SessionRow(session, { open(OrbitRoute(Destination.SESSION, session.id, route.workspaceId, origin = Origin.LIST)) }) {
            action = DirectoryDialog.SessionMenu(session, view)
        }
    }
    PullToRefreshBox(isRefreshing = refreshing, onRefresh = { refresh() }, modifier = Modifier.fillMaxSize().testTag("project-sessions")) {
        LazyColumn(Modifier.fillMaxSize().testTag("project-sessions-list"), contentPadding = PaddingValues(bottom = 24.dp)) {
            // The page's first card: the project's ending once it is done (docs/mocks/project-done-sessions-page, owner decision
            // 2026-10-10) — the same settled card the conversation draws, where a progress card would say nothing but "Done" — and the
            // progress card before that, and for a read that carries no projection to tally.
            val ending = state.done?.takeIf(ProjectDone::drawsEnding)
            item(key = "progress") {
                if (ending != null) {
                    // The page's own card chrome, as the merge card wears it — the ending is the last of its events.
                    val success = LocalOrbitColors.current.success
                    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp)
                        .background(success.copy(alpha = 0.08f), RoundedCornerShape(14.dp))
                        .border(1.dp, success.copy(alpha = 0.3f), RoundedCornerShape(14.dp)).padding(12.dp)) {
                        ProjectSettledCard(ending, "project-sessions-ending")
                    }
                } else ProgressCard(project, members, state, openStart = { startSheet = it })
            }
            // The task landing on the project branch as a card of its own, under the progress card and only while something is in
            // flight (iOS 749d995c5, owner decision 2026-10-11, docs/mocks/project-landing-card). A press opens the jobs it counts — or,
            // from a server that lists none, the project page; a merge job's line is the merge card's, below.
            if (ending == null) state.integration?.let { integration ->
                ProjectMergeCard.taskLandingCard(integration, now, state.integrationReadAt, state.integrationReadFailed)?.let { card ->
                    item(key = "landing") {
                        ProjectLandingCardView(card, onOpenJobs = if (ProjectPage.inFlightJobs(integration) != null) ({ showsJobs = true }) else null,
                            onOpenProject = ::openProject, openLanding = { id -> open(OrbitRoute(Destination.SESSION, id, route.workspaceId, origin = Origin.LIST)) },
                            retry = { retryJob(it) }, modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp))
                    }
                }
            }
            // The merge into main, under the landing: the candidate's card while it asks, merges or is blocked, and the merge check's
            // live line before that. Absent otherwise — a merge already made is a row of the project's Landings window instead.
            ProjectMergeCard.shape(merge.current, state.integration)?.let { shape ->
                item(key = "merge") {
                    val integration = state.integration
                    // The round's own job, for the timed-out card's two doors and its detail (J-T9, J-T10).
                    val mergeJob = ProjectMergeCard.mergeJob(integration)
                    ProjectMergeCardView(merge, shape,
                        landing = integration?.let { ProjectMergeCard.mergeLandingLine(it, now, state.integrationReadAt, state.integrationReadFailed) },
                        // Who is in front of a blocked candidate, off the page's own landing read.
                        blockedBy = merge.current?.let { ProjectMergeCard.blockedByLine(it, integration) },
                        now = now,
                        // The merge job's row opens the same jobs the landing card's does — on a server that lists them.
                        onLanding = if (integration?.let(ProjectPage::inFlightJobs) != null) ({ showsJobs = true }) else null,
                        roundLanding = ProjectMergeCard.roundLandingSessionId(merge.current, integration),
                        mergeJob = mergeJob,
                        mergeJobDetail = integration?.let { ProjectPage.landingJobLines(it, now, state.integrationReadAt, state.integrationReadFailed) }
                            ?.firstOrNull { it.jobId == mergeJob?.text("jobId") }?.detail,
                        jobCount = (integration?.number("integratingCount") ?: 0) + (integration?.number("queuedCount") ?: 0),
                        openLanding = { id -> open(OrbitRoute(Destination.SESSION, id, route.workspaceId, origin = Origin.LIST)) },
                        abandon = { jobId -> landingDoor { projects.abandonJob(projectId, jobId) } },
                        rerunCheck = { promotionId -> landingDoor {
                            projects.recheckPromotion(projectId, promotionId, LandingSessionCopy.RERUN_CHECK_REASON) } },
                        onDetails = { promotionReview = it },
                        onCoordinator = coordinator?.let { c -> { open(OrbitRoute(Destination.SESSION, c.id, route.workspaceId, origin = Origin.LIST)) } })
                }
            }
            coordinator?.let { c ->
                item(key = "heading:coordinator") { SectionHeading(SessionProjectCopy.coordinatorSection) }
                item(key = c.id) { MemberRow(c) }
            }
            // The project's landings, summed up in one row (owner 2026-10-27, board docs/mocks/landings-one-window 01 b): under the
            // coordinator, above the timeline, and absent for a project that has never had a landing. The whole row opens the project's
            // Landings window, at its bottom; the window lists every landing, and the merges into main among them.
            SessionProjectLandings.rowSummary(state.landings, merge.merged, now,
                main = RunSettings.mainBranchName(state.integration?.text("upstreamRef")))?.let { summary ->
                item(key = "heading:landings") { SectionHeading(SessionLandingsCopy.title) }
                item(key = "landings") {
                    LandingsRowView(summary) { open(OrbitRoute(Destination.LANDINGS, projectId, route.workspaceId, origin = Origin.LIST)) }
                }
            }
            // The members by recency, newest first, in the list's day sections — without Pinned: the page has none. Sessions only: the
            // merges into main are rows of the Landings window.
            ProjectTimeline.sections(members.filter { it.projectMembership?.isCoordinator != true }).forEach { section ->
                item(key = "heading:${section.id}") { SectionHeading(section.title) }
                items(section.sessions, key = { it.id }) { session -> MemberRow(session) }
            }
            if (members.isEmpty()) {
                val reason = state.error
                // A failure stays up while the next poll is in flight, rather than blinking out every 4 s.
                if (reason != null) item(key = "failed") { StatusMessage("Couldn't load sessions", reason) { scope.launch { loadMembers() } } }
                else if (!state.loading) item(key = "empty") {
                    Text("No sessions", Modifier.fillMaxWidth().padding(24.dp).semantics { liveRegion = LiveRegionMode.Polite }.testTag("project-sessions-empty"),
                        style = MaterialTheme.typography.titleMedium)
                }
            }
        }
    }
    action?.let { dialog ->
        DirectoryActionDialog(dialog, api, data, setDialog = { action = it }) { app.realtime.refreshDirectory(); scope.launch { loadMembers() } }
    }
    // The start card over this page, read afresh as it opens: this page holds none of the criteria, the plan or the line it is set from.
    val live by app.realtime.state.collectAsState()
    val auth by app.session.state.collectAsState()
    val enabled = writable(live, handle, (auth as? AuthState.SignedIn)?.handle)
    val startWrite: suspend (JsonObject) -> String? = { body ->
        try { projects.start(projectId, body); app.realtime.refreshDirectory(); null }
        catch (cancel: CancellationException) { throw cancel }
        catch (failure: Exception) { "${StartProjectCopy.notRecorded} — ${failureReason(failure)}." }
    }
    // "View tasks ›" on the card: the project's page, where its task list is.
    val viewTasks = { startSheet = null; openProject() }
    when (startSheet) {
        StartSheet.ASKED -> RequestedStartSheet(projects, projectId, enabled, viewTasks, close = { startSheet = null; scope.launch { loadStart() } }, start = startWrite)
        StartSheet.OWN -> {
            // The owner's own card reads the document, the plan and the line it starts from, as the project page has them; a read that
            // did not answer is asked again every 4 s until the card can be drawn, and a document that could not be read is said, with
            // Retry, in the spinner's place.
            val page = remember(projectId) { ProjectPageState() }
            var failure by remember(projectId) { mutableStateOf<String?>(null) }
            var retries by remember(projectId) { mutableIntStateOf(0) }
            LaunchedEffect(page, retries) {
                while (page.document == null || page.integration == null) {
                    var documentFailed: String? = null
                    coroutineScope {
                        launch { if (page.document == null) StartSheetLoad.read({ documentFailed = it }) { projects.document(projectId) }?.let { page.document = it } }
                        launch { if (page.graph == null) StartSheetLoad.read { projects.graph(projectId) }?.let { page.graph = it } }
                        launch { if (page.integration == null) StartSheetLoad.read { projects.integration(projectId) }.let { page.integration = it; page.integrationReadFailed = it == null } }
                    }
                    failure = documentFailed
                    if (page.document == null || page.integration == null) delay(4_000)
                }
            }
            OwnerStartSheet(projects, projectId, page, enabled, viewTasks, close = { startSheet = null; scope.launch { loadStart() } },
                failure = failure, retry = { retries++ }, start = startWrite)
        }
        null -> Unit
    }
    // The review's "Blocked by" row is the card's, off the same landing read (iOS reads it again for the sheet; this page reads it every 4 s).
    promotionReview?.let { id ->
        ProjectMergeReviewSheet(merge, id, merge.standing(id)?.let { ProjectMergeCard.blockedByLine(it, state.integration) }) { promotionReview = null }
    }
    // The jobs the landing card counts, read off the page's own landing read, which its poll keeps current.
    if (showsJobs) LandingJobsSheet(state.integration?.let { ProjectPage.landingJobLines(it, now, state.integrationReadAt, state.integrationReadFailed) }.orEmpty(),
        retry = { retryJob(it) }, openTask = { taskId -> showsJobs = false; open(OrbitRoute(Destination.TASK, taskId)) },
        openLanding = { id -> showsJobs = false; open(OrbitRoute(Destination.SESSION, id, route.workspaceId, origin = Origin.LIST)) },
        close = { showsJobs = false })
}

/** The project's one Landings row (owner 2026-10-27, board docs/mocks/landings-one-window 01 b; iOS `landingsRow`, web
 * `SessionProjectLandings`): the merged line's head — one circle with the mark of the most urgent landing (✕ one waits for a decision,
 * the blue ring one is in flight, ✓ all settled), the title, how long the longest of them has waited or how long ago the last one
 * settled, and the counts under them, two lines at most. The whole row opens the project's Landings window. */
@Composable
private fun LandingsRowView(summary: LandingsRowSummary, onOpen: () -> Unit) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val ink = when (summary.mark) {
        LandingsRowMark.FAIL -> MaterialTheme.colorScheme.error
        LandingsRowMark.RUNNING -> MaterialTheme.colorScheme.primary
        LandingsRowMark.OK -> LocalOrbitColors.current.success
    }
    Row(Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = onOpen).padding(horizontal = 16.dp, vertical = 10.dp)
        .testTag("landings-row"), verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(11.dp)) {
        Box(Modifier.size(30.dp).background(ink.copy(alpha = 0.14f), CircleShape).testTag("landings-row:mark:${summary.mark.name.lowercase()}"),
            contentAlignment = Alignment.Center) {
            when (summary.mark) {
                LandingsRowMark.FAIL -> Text("✕", fontWeight = FontWeight.SemiBold, color = ink)
                LandingsRowMark.RUNNING -> LandingRing(running = true, size = 15.dp)
                LandingsRowMark.OK -> Text("✓", fontWeight = FontWeight.SemiBold, color = ink)
            }
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(SessionLandingsCopy.title, Modifier.weight(1f).testTag("landings-row:title"), fontWeight = FontWeight.SemiBold, maxLines = 1,
                    overflow = TextOverflow.Ellipsis)
                if (summary.time.isNotEmpty()) Text(summary.time, Modifier.testTag("landings-row:time"), style = MaterialTheme.typography.labelMedium,
                    color = muted, maxLines = 1, softWrap = false)
            }
            Text(summary.line, Modifier.testTag("landings-row:line"), style = MaterialTheme.typography.bodyMedium, color = muted, maxLines = 2,
                overflow = TextOverflow.Ellipsis)
        }
    }
}

/** The progress card (iOS `progressCard`): the mini bar and "done/total done · running" — "Not started · N tasks" for a project
 * nobody has started — then the start. The landing left it on 2026-10-11 for a card of its own under it. */
@Composable
private fun ProgressCard(project: JsonObject?, members: List<DirectorySession>, state: ProjectSessionsState, openStart: (StartSheet) -> Unit) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp).background(muted.copy(alpha = 0.1f), RoundedCornerShape(12.dp))
        .testTag("project-sessions-progress")) {
        val counts = project?.obj("taskCounts")?.let { ProjectTaskCounts(it.number("done") ?: 0, it.number("failed") ?: 0, it.number("total") ?: 0) }
        val running = members.count { it.isRunning() }
        Row(Modifier.fillMaxWidth().padding(12.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            if (counts != null) {
                ProjectProgressBar(counts, running, Modifier.width(66.dp))
                val notStarted = project.text("status") == "OPEN" && ProjectDoc.started(project) == false
                Text(if (notStarted) SessionProjectCopy.pageNotStarted(counts.total) else SessionProjectCopy.pageProgress(counts.done, counts.total, running),
                    Modifier.testTag("project-sessions-progress-line"), style = MaterialTheme.typography.labelMedium, color = muted)
            } else Text((project?.text("status") ?: members.firstOrNull()?.projectMembership?.projectStatus)?.let(SessionProjectCopy::statusLabel) ?: "Project",
                Modifier.testTag("project-sessions-progress-line"), style = MaterialTheme.typography.labelMedium, color = muted)
        }
        project?.let { StartProjectCopy.pageRow(it.text("status") ?: "UNKNOWN", ProjectDoc.started(it), state.openItems) }?.let { StartLine(it, state.integration, openStart) }
    }
}

/** The start under the progress line, while nobody has started the project (iOS `startLine`): the coordinator's request — Ready to
 * start, since when, what it suggests, and Review and start — or, with none, the owner's own Start…, quiet. Either opens the start
 * card over the page, and only that card's Start starts anything. */
@Composable
private fun StartLine(row: StartProjectCopy.PageRow, integration: JsonObject?, openStart: (StartSheet) -> Unit) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Column(Modifier.fillMaxWidth().padding(start = 12.dp, end = 12.dp, bottom = 12.dp).testTag("project-sessions-start"), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        when (row) {
            is StartProjectCopy.PageRow.Asked -> {
                Column(Modifier.semantics(mergeDescendants = true) {}, verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                        Box(Modifier.size(8.dp).background(LocalOrbitColors.current.needsYou, CircleShape))
                        Text(StartProjectCopy.readyToStart, Modifier.weight(1f), style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
                        row.row.text("waitingSince")?.let { WikiDate.relative(it, Instant.now()) }?.let {
                            Text(SessionProjectCopy.startAsked(it), style = MaterialTheme.typography.labelMedium, color = muted, maxLines = 1)
                        }
                    }
                    // Directly into the main branch the start card opens with, off the integration read the landing line holds.
                    row.row.obj("startRequest")?.obj("settings")?.let {
                        Text(SessionProjectCopy.startSuggestion(it, StartProjectCopy.startMainBranch(it.text("upstreamRef"), integration)), Modifier.padding(start = 15.dp),
                            style = MaterialTheme.typography.labelMedium, color = muted)
                    }
                }
                Button(onClick = { openStart(StartSheet.ASKED) }, modifier = Modifier.fillMaxWidth().testTag("project-sessions-review-start")
                    .semantics { onClick(label = SessionProjectCopy.startHint) { openStart(StartSheet.ASKED); true } }) {
                    Text(SessionProjectCopy.startReview, fontWeight = FontWeight.SemiBold)
                }
            }
            StartProjectCopy.PageRow.Own -> {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                    Box(Modifier.size(8.dp).background(muted.copy(alpha = 0.45f), CircleShape))
                    Text(SessionProjectCopy.startNotAsked, style = MaterialTheme.typography.labelMedium, color = muted)
                }
                OutlinedButton(onClick = { openStart(StartSheet.OWN) }, modifier = Modifier.fillMaxWidth().testTag("project-sessions-start-own")
                    .semantics { onClick(label = SessionProjectCopy.startHint) { openStart(StartSheet.OWN); true } }) {
                    Text(StartProjectCopy.rowOwn, fontWeight = FontWeight.SemiBold)
                }
            }
        }
    }
}
