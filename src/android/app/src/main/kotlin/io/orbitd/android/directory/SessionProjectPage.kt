package io.orbitd.android.directory

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
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
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
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
import io.orbitd.android.projects.LandingRow
import io.orbitd.android.projects.OwnerStartSheet
import io.orbitd.android.projects.ProjectApi
import io.orbitd.android.projects.ProjectDoc
import io.orbitd.android.projects.ProjectPage
import io.orbitd.android.projects.ProjectPageState
import io.orbitd.android.projects.RequestedStartSheet
import io.orbitd.android.projects.StartProjectCopy
import io.orbitd.android.projects.failureReason
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
                // The line, with the recap's muted label when it has one (web draws it in the row's quiet tone).
                Text(row.line.label?.let { label -> buildAnnotatedString {
                        withStyle(SpanStyle(color = MaterialTheme.colorScheme.onSurfaceVariant)) { append("$label ") }
                        append(row.line.text)
                    } } ?: AnnotatedString(row.line.text),
                    Modifier.testTag("project-row-line"), maxLines = 1, overflow = TextOverflow.Ellipsis,
                    style = MaterialTheme.typography.bodyMedium, color = lineColor(row.line.tone))
            }
        },
        trailingContent = { IconButton(onOptions) { Icon(painterResource(R.drawable.ic_more), "Options for ${row.title}") } },
        modifier = Modifier.clickable(role = Role.Button, onClick = onOpen).semantics { stateDescription = words }.testTag("project-row:${row.projectId}"))
}

@Composable
private fun lineColor(tone: SessionLine.Tone): Color = when (tone) {
    SessionLine.Tone.APPROVAL -> LocalOrbitColors.current.needsYou
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
    var members by mutableStateOf(initial)
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
}

private enum class StartSheet { ASKED, OWN }

/**
 * A project's sessions (iOS `SessionProjectPage`, A05-7), pushed over the list it was opened from, or the root of the drawer's project
 * row: its progress — with the start while nobody has started the project, and the landing in flight — then its coordinator, then
 * every other member by recency, Open and Completed together. No search and no Pinned: it lists one project's sessions. A member
 * opens over this page, and the workspace the page was entered from stays the one beneath it. Members, the landing and the start
 * are each read every 4 s; the progress comes from `GET /projects/sidebar`.
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

    suspend fun read(view: String): List<DirectorySession> =
        api.read(listOf("sessions"), ListSerializer(DirectorySession.serializer()), listOf("view" to view, "projectId" to projectId))
    /** Both lists; an older server may ignore projectId, so only the project's members are kept, and never one in Trash. */
    suspend fun loadMembers() {
        state.loading = true
        try {
            val rows = coroutineScope { val open = async { read("open") }; val completed = async { read("completed") }; open.await() + completed.await() }
            state.members = SessionProjectMembers.members(projectId, rows)
            state.completed = state.members.filter { it.effectiveLifecycleState != "OPEN" }
            state.readAt = Instant.now(); state.error = null
        } catch (cancel: CancellationException) { throw cancel }
        catch (failure: Exception) { state.error = CodexSignInText.sentence(failureReason(failure)) }
        finally { state.loading = false }
    }
    /** One poll that asks for neither list again unless something moved: the Open members are the app's Open list's, kept current by
     * its control stream; the Completed ones are read again when an Open member left that list, or a minute after the last read. */
    suspend fun pollMembers() {
        val readAt = state.readAt
        if (state.error != null || readAt == null || !currentData.ready) return loadMembers()
        val openList = currentData.sessions["open"].orEmpty()
        val (members, moved) = SessionProjectMembers.poll(state.members, projectId, openList, state.completed)
        if (members != state.members) state.members = members
        if (!moved && Instant.now().toEpochMilli() - readAt.toEpochMilli() < SessionProjectMembers.completedRefreshMs) return
        try {
            val completed = SessionProjectMembers.members(projectId, read("completed"))
            state.completed = completed; state.readAt = Instant.now()
            val next = SessionProjectMembers.members(projectId, currentData.sessions["open"].orEmpty() + completed)
            if (next != state.members) state.members = next
        } catch (cancel: CancellationException) { throw cancel }
        catch (failure: Exception) { state.error = CodexSignInText.sentence(failureReason(failure)) }
    }
    /** The landing line's read; a read that fails keeps the last answer and says it is stale. */
    suspend fun loadIntegration() {
        val view = try { projects.integration(projectId) } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { null }
        if (view != null) { state.integration = view; state.integrationReadAt = Instant.now(); state.integrationReadFailed = false }
        else state.integrationReadFailed = true
    }
    /** The start row's read, while the sidebar says nobody has started the project; a read that fails keeps the last answer. */
    suspend fun loadStart() {
        val row = currentProject
        if (row?.text("status") != "OPEN" || ProjectDoc.started(row) != false) { state.openItems = null; return }
        val items = try { projects.openItems(projectId) } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { null }
        if (items != null) state.openItems = items
    }
    LaunchedEffect(handle, projectId) {
        launch { loadMembers(); while (true) { delay(4_000); pollMembers() } }
        launch { while (true) { loadIntegration(); delay(4_000) } }
        launch { while (true) { loadStart(); delay(4_000) } }
        launch { while (true) { delay(1_000); now = Instant.now() } }
    }
    fun refresh() = scope.launch {
        refreshing = true
        try { coroutineScope { launch { loadMembers() }; launch { loadIntegration() }; launch { loadStart() } } } finally { refreshing = false }
    }
    // The project's page, over this one: back returns here.
    fun openProject() = open(OrbitRoute(Destination.PROJECT, projectId))

    val members = state.members
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
            item(key = "progress") {
                ProgressCard(project, members, state, now, openStart = { startSheet = it },
                    openLanding = { if (state.integration?.let(ProjectPage::inFlightJobs) != null) showsJobs = true else openProject() })
            }
            coordinator?.let { c ->
                item(key = "heading:coordinator") { SectionHeading(SessionProjectCopy.coordinatorSection) }
                item(key = c.id) { MemberRow(c) }
            }
            // The members by recency, newest first, in the list's day sections — without Pinned: the page has none.
            directoryGroups(members.filter { it.projectMembership?.isCoordinator != true }, SessionView.COMPLETED, Grouping.RECENCY).forEach { group ->
                item(key = "heading:${group.id}") { SectionHeading(group.title) }
                items(group.sessions, key = { it.id }) { MemberRow(it) }
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
            // did not answer is asked again every 4 s until the card can be drawn.
            val page = remember(projectId) { ProjectPageState() }
            LaunchedEffect(page) {
                suspend fun <T> read(block: suspend () -> T): T? = try { block() } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { null }
                while (page.document == null || page.integration == null) {
                    coroutineScope {
                        launch { if (page.document == null) read { projects.document(projectId) }?.let { page.document = it } }
                        launch { if (page.graph == null) read { projects.graph(projectId) }?.let { page.graph = it } }
                        launch { if (page.integration == null) read { projects.integration(projectId) }.let { page.integration = it; page.integrationReadFailed = it == null } }
                    }
                    if (page.document == null || page.integration == null) delay(4_000)
                }
            }
            OwnerStartSheet(projects, projectId, page, enabled, viewTasks, close = { startSheet = null; scope.launch { loadStart() } }, start = startWrite)
        }
        null -> Unit
    }
    // The jobs the landing row counts, read off the page's own landing read, which its poll keeps current.
    if (showsJobs) LandingJobsSheet(state.integration?.let { ProjectPage.landingJobLines(it, now, state.integrationReadAt, state.integrationReadFailed) }.orEmpty(),
        retry = { jobId ->
            try { projects.retryJob(projectId, jobId)?.let { view -> state.integration = view; state.integrationReadAt = Instant.now(); state.integrationReadFailed = false }; null }
            catch (cancel: CancellationException) { throw cancel }
            catch (failure: Exception) { "${ProjectPage.landingRetryFailed} — ${failureReason(failure).trimEnd('.')}." }
        }, openTask = { taskId -> showsJobs = false; open(OrbitRoute(Destination.TASK, taskId)) }, close = { showsJobs = false })
}

/** The progress card (iOS `progressCard`): the mini bar and "done/total done · running" — "Not started · N tasks" for a project
 * nobody has started — then the start, and the landing in flight. */
@Composable
private fun ProgressCard(project: JsonObject?, members: List<DirectorySession>, state: ProjectSessionsState, now: Instant,
    openStart: (StartSheet) -> Unit, openLanding: () -> Unit) {
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
        project?.let { StartProjectCopy.pageRow(it.text("status") ?: "UNKNOWN", ProjectDoc.started(it), state.openItems) }?.let { StartLine(it, openStart) }
        // A merge job's line belongs to the merge into main, not to tasks landing on the project branch.
        val integration = state.integration
        val inFlight = integration?.obj("inFlight")
        if (integration != null && inFlight != null && inFlight.text("kind") !in setOf("CHECK_PROMOTION", "LAND_PROMOTION")) {
            ProjectPage.landingLine(integration, now, state.integrationReadAt, state.integrationReadFailed)?.let { line ->
                HorizontalDivider(Modifier.padding(start = 12.dp))
                Box(Modifier.padding(horizontal = 12.dp, vertical = 6.dp)) { LandingRow(line, openLanding) }
            }
        }
    }
}

/** The start under the progress line, while nobody has started the project (iOS `startLine`): the coordinator's request — Ready to
 * start, since when, what it suggests, and Review and start — or, with none, the owner's own Start…, quiet. Either opens the start
 * card over the page, and only that card's Start starts anything. */
@Composable
private fun StartLine(row: StartProjectCopy.PageRow, openStart: (StartSheet) -> Unit) {
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
                    row.row.obj("startRequest")?.obj("settings")?.let {
                        Text(SessionProjectCopy.startSuggestion(it), Modifier.padding(start = 15.dp), style = MaterialTheme.typography.labelMedium, color = muted)
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
