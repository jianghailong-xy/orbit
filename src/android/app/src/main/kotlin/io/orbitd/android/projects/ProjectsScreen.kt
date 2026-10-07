package io.orbitd.android.projects

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.cards.*
import io.orbitd.android.core.net.ApiError
import io.orbitd.android.navigation.*
import io.orbitd.android.taskprojects.*
import io.orbitd.android.tasks.OfflineNote
import io.orbitd.android.text.*
import io.orbitd.android.ui.LocalOrbitColors
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*
import java.time.Instant
import java.util.UUID

/** Projects keep the host's object stack, the A03 handle and A04's invalidation stream. */
@Composable
fun ProjectsScreen(app: OrbitApplication, handle: SessionHandle, route: OrbitRoute, revision: Long, open: (OrbitRoute) -> Unit, back: () -> Unit = {}) {
    val resources = LocalReaderResources.current ?: remember(handle) { ReaderResources(app.session, handle) }
    CompositionLocalProvider(LocalReaderResources provides resources) {
        val id = route.id
        if (id == null) ProjectIndex(app, handle, revision, open) else ProjectDetail(app, handle, id, revision, open, back)
    }
}

/** `ProjectPalette`: one colour per work lane, and a shape beside every colour. */
@Composable
internal fun glyphColor(glyph: Glyph): Color = when (glyph) {
    Glyph.DISC, Glyph.SPINNER, Glyph.HOURGLASS -> MaterialTheme.colorScheme.primary
    Glyph.TRIANGLE -> LocalOrbitColors.current.needsYou
    Glyph.SQUARE -> MaterialTheme.colorScheme.onSurfaceVariant
    Glyph.CHECK, Glyph.BRANCH -> LocalOrbitColors.current.success
    Glyph.CROSS -> MaterialTheme.colorScheme.error
    Glyph.SLASH -> MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f)
}
internal fun glyphText(glyph: Glyph) = when (glyph) {
    Glyph.DISC -> "●"; Glyph.TRIANGLE -> "▲"; Glyph.SQUARE -> "■"; Glyph.HOURGLASS -> "⧗"; Glyph.CHECK -> "✓"; Glyph.CROSS -> "✕"
    Glyph.SLASH -> "⊘"; Glyph.SPINNER -> "◌"; Glyph.BRANCH -> "⎇"
}
@Composable
internal fun toneColor(tone: TagTone): Color = when (tone) {
    TagTone.NEUTRAL -> MaterialTheme.colorScheme.onSurfaceVariant
    TagTone.BRAND, TagTone.VERIFICATION -> MaterialTheme.colorScheme.primary
    TagTone.WARNING -> LocalOrbitColors.current.needsYou
    TagTone.DANGER -> MaterialTheme.colorScheme.error
    TagTone.SUCCESS -> LocalOrbitColors.current.success
}

@Composable
internal fun Chip(text: String, tone: TagTone, modifier: Modifier = Modifier) {
    val color = toneColor(tone)
    Text(text, modifier.background(color.copy(alpha = 0.13f), RoundedCornerShape(6.dp)).padding(horizontal = 7.dp, vertical = 2.dp),
        style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, color = color, maxLines = 1, overflow = TextOverflow.Ellipsis)
}

/** A row of coloured segments, one per lane (`ProjectMeter`). */
@Composable
internal fun Meter(segments: List<Pair<Int, Color>>, modifier: Modifier = Modifier, height: Int = 5) {
    val total = segments.sumOf { it.first }
    Row(modifier.height(height.dp).fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(50))) {
        if (total > 0) segments.filter { it.first > 0 }.forEach { (value, color) -> Box(Modifier.weight(value.toFloat()).fillMaxHeight().background(color)) }
    }
}

@Composable
internal fun SectionHead(title: String, detail: String? = null, modifier: Modifier = Modifier, trailing: @Composable () -> Unit = {}) {
    Row(modifier.fillMaxWidth().padding(top = 18.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(title, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
        detail?.let { Text(it, Modifier.weight(1f, fill = false), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis) }
        Spacer(Modifier.weight(1f))
        trailing()
    }
}

// MARK: the index

@Composable
private fun ProjectIndex(app: OrbitApplication, handle: SessionHandle, revision: Long, open: (OrbitRoute) -> Unit) {
    val api = remember(handle) { ProjectApi(app.session, handle) }
    var projects by remember(handle) { mutableStateOf<List<JsonObject>?>(null) }
    var failed by remember(handle) { mutableStateOf(false) }
    var loading by remember(handle) { mutableStateOf(false) }
    var query by rememberSaveable { mutableStateOf("") }
    var showsCompleted by rememberSaveable { mutableStateOf(false) }
    var now by remember { mutableStateOf(Instant.now()) }
    val scope = rememberCoroutineScope()
    suspend fun load() {
        loading = true
        try { projects = api.index(); failed = false }
        catch (cancel: CancellationException) { throw cancel }
        catch (_: Exception) { failed = true }
        finally { loading = false }
    }
    LaunchedEffect(handle) { load() }
    LaunchedEffect(handle, revision) { if (revision > 0 && projects != null) { delay(400); load() } }
    LaunchedEffect(Unit) { while (true) { delay(60_000); now = Instant.now() } }
    val matching = projects.orEmpty().filter { ProjectAttention.matches(it, query) }
    Column(Modifier.fillMaxSize()) {
        OutlinedTextField(query, { query = it }, Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp).testTag("project-search"),
            label = { Text(ProjectPage.searchProjects) }, singleLine = true)
        Box(Modifier.weight(1f)) {
            LazyColumn(Modifier.fillMaxSize().testTag("projects-list"), contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 24.dp)) {
                ProjectAttention.lanes(matching, now).filter { it.second.isNotEmpty() }.forEach { (lane, rows) ->
                    item(key = "lane:${lane.name}") {
                        Row(Modifier.fillMaxWidth().padding(top = 14.dp, bottom = 4.dp), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Text(lane.title, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold)
                            Text("${rows.size}", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            Spacer(Modifier.weight(1f))
                            if (lane.defaultCollapsed && query.isEmpty()) TextButton(onClick = { showsCompleted = !showsCompleted }) { Text(if (showsCompleted) "Hide" else "Show") }
                        }
                    }
                    if (!lane.defaultCollapsed || showsCompleted || query.isNotEmpty()) items(rows, key = { "project:${it.text("id")}" }) { project ->
                        ProjectRow(project, now) { project.text("id")?.let { open(OrbitRoute(Destination.PROJECT, it)) } }
                    }
                }
            }
            when {
                projects == null && !failed -> CircularProgressIndicator(Modifier.align(Alignment.Center))
                projects == null && failed -> Column(Modifier.align(Alignment.Center).padding(24.dp).testTag("projects-failed"), horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(ProjectPage.listLoadFailed, style = MaterialTheme.typography.titleMedium)
                    Text(ProjectPage.listLoadFailedDetail, style = MaterialTheme.typography.bodySmall)
                    Button(onClick = { scope.launch { load() } }, enabled = !loading) { Text("Retry") }
                }
                projects?.isEmpty() == true -> Column(Modifier.align(Alignment.Center).padding(24.dp).testTag("projects-empty"), horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(ProjectPage.noProjects, style = MaterialTheme.typography.titleMedium)
                    Text(ProjectPage.noProjectsDetail, style = MaterialTheme.typography.bodySmall)
                }
                query.isNotEmpty() && matching.isEmpty() -> Text("No results for “${query.trim()}”", Modifier.align(Alignment.Center))
            }
        }
    }
}

/** One project: title and quiet age, the chip that says why it is where it is, the meter and counts, its line. */
@Composable
private fun ProjectRow(project: JsonObject, now: Instant, open: () -> Unit) {
    val b = project.obj("buckets") ?: JsonObject(emptyMap())
    fun n(key: String) = b.number(key) ?: 0
    val failed = ProjectAttention.failedTaskCount(project)
    Column(Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = open).padding(vertical = 8.dp).testTag("project:${project.text("id")}"),
        verticalArrangement = Arrangement.spacedBy(5.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(project.text("title").orEmpty(), Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis,
                color = if (ProjectAttention.open(project)) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant)
            ProjectTime.elapsed(project.text("lastActivityAt"), now)?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
        ProjectAttention.chip(project, now)?.let { Chip(it.text, if (it.warning) TagTone.WARNING else TagTone.BRAND, Modifier.testTag("project-chip")) }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Meter(listOf(n("running") to glyphColor(Glyph.DISC), n("ready") to glyphColor(Glyph.TRIANGLE), (n("blocked") + n("awaitingVerification")) to glyphColor(Glyph.SQUARE),
                failed to glyphColor(Glyph.CROSS), n("done") to glyphColor(Glyph.CHECK), n("cancelled") to glyphColor(Glyph.SLASH)), Modifier.widthIn(max = 110.dp))
            listOf(Glyph.DISC to n("running"), Glyph.TRIANGLE to n("ready"), Glyph.SQUARE to n("blocked") + n("awaitingVerification"), Glyph.CROSS to failed, Glyph.CHECK to n("done"))
                .filter { it.second > 0 }.forEach { (glyph, value) ->
                    Text("${glyphText(glyph)} $value", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            Spacer(Modifier.weight(1f))
            ProjectAttention.integrationChip(project)?.let { Text("${if (it.branch) "⎇" else "↓"} ${it.text}", style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis) }
        }
    }
    HorizontalDivider()
}

// MARK: one project

/** Everything one project's page read. A read that fails keeps the last answer; the document decides gone. */
internal class ProjectPageState {
    var document by mutableStateOf<JsonObject?>(null)
    var missing by mutableStateOf(false)
    var loadFailed by mutableStateOf(false)
    var panorama by mutableStateOf<JsonObject?>(null)
    var integration by mutableStateOf<JsonObject?>(null)
    var integrationReadAt by mutableStateOf<Instant?>(null)
    var integrationReadFailed by mutableStateOf(false)
    var openItems by mutableStateOf<JsonObject?>(null)
    var coordinator by mutableStateOf<JsonObject?>(null)
    var graph by mutableStateOf<JsonObject?>(null)
    var queue by mutableStateOf<JsonObject?>(null)
    var queueUnread by mutableStateOf(false)
    var tasks by mutableStateOf<List<JsonObject>>(emptyList())
    var cursor by mutableStateOf<String?>(null)
    var loadingMore by mutableStateOf(false)
    var share by mutableStateOf<JsonObject?>(null)
    var busy by mutableStateOf(false)
    /** At most as the stepper has it while the write it will make waits for the presses to stop. */
    var pendingConcurrency by mutableStateOf<Int?>(null)
    var starting by mutableStateOf<Set<String>>(emptySet())
    var notice by mutableStateOf<String?>(null)
    var copied by mutableStateOf<String?>(null)
    var refreshing = false
}

private sealed interface ProjectDialog {
    data class Status(val status: String) : ProjectDialog
    data object Delete : ProjectDialog
    data object Replace : ProjectDialog
    data class Resolve(val blocker: JsonObject) : ProjectDialog
    data class ResumeList(val item: JsonObject) : ProjectDialog
    data object Start : ProjectDialog
    data object MergeCheck : ProjectDialog
    data object Share : ProjectDialog
}

@Composable
private fun ProjectDetail(app: OrbitApplication, handle: SessionHandle, id: String, revision: Long, open: (OrbitRoute) -> Unit, back: () -> Unit) {
    val api = remember(handle) { ProjectApi(app.session, handle) { app.canWrite(handle) } }
    val state = remember(handle, id) { ProjectPageState() }
    val scope = rememberCoroutineScope()
    val live by app.realtime.state.collectAsState()
    val auth by app.session.state.collectAsState()
    val connected = writable(live, handle, (auth as? AuthState.SignedIn)?.handle)
    val clipboard = LocalClipboardManager.current
    val resources = LocalReaderResources.current ?: remember(handle) { ReaderResources(app.session, handle) }
    val link = rememberReaderLinkHandler(resources, open)
    var dialog by remember { mutableStateOf<ProjectDialog?>(null) }
    var menu by remember { mutableStateOf(false) }
    var now by remember { mutableStateOf(Instant.now()) }
    val listState = rememberLazyListState()
    val openTask: (String) -> Unit = { open(OrbitRoute(Destination.TASK, it)) }

    /** Every section at once, each keeping its last answer when its read fails (`ProjectDetailModel.load`). */
    suspend fun load(refreshGraph: Boolean = true, settled: Boolean = false) {
        // A write's own read waits for one already out rather than being dropped behind it.
        if (settled) while (state.refreshing || state.loadingMore) delay(50)
        if (state.refreshing || state.loadingMore) return
        state.refreshing = true
        try {
            coroutineScope {
                val document = async { runCatching { api.document(id) } }
                val panorama = async { runCatching { api.panorama(id) }.getOrNull() }
                val integration = async { runCatching { api.integration(id) }.getOrNull() }
                val openItems = async { runCatching { api.openItems(id) }.getOrNull() }
                val coordinator = async { runCatching { api.coordinator(id) }.getOrNull() }
                val graph = async { if (refreshGraph) runCatching { api.graph(id) }.getOrNull() else null }
                val queue = async { runCatching { api.ready(id) } }
                val tasks = async { runCatching { api.taskWindow(id, maxOf(100, state.tasks.size)) }.getOrNull() }
                val share = async { runCatching { api.share(id) }.getOrNull() }
                document.await().onSuccess { state.document = it; state.missing = false; state.loadFailed = false }.onFailure { failure ->
                    if (failure is CancellationException) throw failure
                    if (failure is ApiError && failure.status in setOf(403, 404)) { state.missing = true; state.document = null } else state.loadFailed = true
                }
                panorama.await()?.let { state.panorama = it }
                integration.await().let { if (it != null) { state.integration = it; state.integrationReadAt = Instant.now(); state.integrationReadFailed = false } else state.integrationReadFailed = true }
                openItems.await()?.let { state.openItems = it }
                coordinator.await()?.let { state.coordinator = it }
                graph.await()?.let { state.graph = it }
                queue.await().onSuccess { state.queue = it; state.queueUnread = false }.onFailure { if (it is CancellationException) throw it; state.queueUnread = true }
                tasks.await()?.let { (items, cursor) -> state.tasks = items; state.cursor = cursor }
                share.await()?.let { state.share = it }
            }
        } finally { state.refreshing = false }
    }
    LaunchedEffect(handle, id) { load() }
    LaunchedEffect(handle, id, revision) { if (revision > 0 && state.document != null) { delay(400); load() } }
    // The visible page follows the work it shows, as the iOS page does, without its graph.
    LaunchedEffect(handle, id) { while (true) { delay(15_000); if (state.document != null) load(refreshGraph = false) } }
    LaunchedEffect(Unit) { while (true) { delay(1_000); now = Instant.now() } }
    LaunchedEffect(state.copied) { if (state.copied != null) { delay(2500); state.copied = null } }

    /** One write: busy while it is out, then the page read again; a refusal comes back as the sentence to show (`write`/`runWrite`). */
    suspend fun attempt(refusal: String, body: suspend () -> Unit): String? {
        if (state.busy) return null
        state.busy = true
        try { body(); return null }
        catch (cancel: CancellationException) { throw cancel }
        catch (failure: Exception) { return "$refusal${failureReason(failure)}." }
        finally { state.busy = false; load(settled = true); app.realtime.refreshDirectory() }
    }
    fun write(refusal: String, body: suspend () -> Unit) { scope.launch { attempt(refusal, body)?.let { state.notice = it } } }
    var concurrencyWrite by remember { mutableStateOf<Job?>(null) }
    /** One press of At most: the number moves now, and one write goes once the presses stop (`stepConcurrency`). */
    fun stepConcurrency(count: Int) {
        state.pendingConcurrency = count
        concurrencyWrite?.cancel()
        concurrencyWrite = scope.launch {
            delay(700)
            val doc = state.document
            if (doc != null && count != doc.number("maxConcurrentTasks")) {
                val body = RunSettings.authorization(doc, maxConcurrentTasks = count)
                (if (body == null) "${RunSettings.notSaved} — reload the project and try again." else attempt("${RunSettings.notSaved} — ") { api.authorize(id, body) })
                    ?.let { state.notice = it }
            }
            if (state.pendingConcurrency == count) state.pendingConcurrency = null
        }
    }
    fun revision(doc: JsonObject) = "${doc.text("configRevision")}:${doc.text("updatedAt")}"
    fun openCoordinator() {
        if (state.busy) return
        scope.launch {
            try { api.openCoordinator(id).text("sessionId")?.let { open(OrbitRoute(Destination.SESSION, it)) } }
            catch (cancel: CancellationException) { throw cancel }
            catch (failure: Exception) { state.notice = "Couldn't open the coordinator: ${failureReason(failure)}." }
        }
    }
    fun replaceCoordinator() = write("Couldn't start a new coordinator: ") {
        api.replaceCoordinator(id, "replace:${state.coordinator?.obj("coordination")?.text("sessionId")}")?.text("sessionId")?.let { open(OrbitRoute(Destination.SESSION, it)) }
    }

    val doc = state.document
    if (doc == null) {
        Box(Modifier.fillMaxSize().testTag("project-detail"), contentAlignment = Alignment.Center) {
            when {
                state.missing -> Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(ProjectPage.gone, style = MaterialTheme.typography.titleMedium); Text(ProjectPage.goneDetail, style = MaterialTheme.typography.bodySmall)
                    TextButton(onClick = back) { Text("Back") }
                }
                state.loadFailed -> Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(ProjectPage.loadFailed, style = MaterialTheme.typography.titleMedium)
                    Button(onClick = { scope.launch { load() } }) { Text("Retry") }
                }
                else -> CircularProgressIndicator()
            }
        }
        return
    }
    val enabled = connected && !state.busy
    val status = ProjectDoc.status(doc)
    val started = ProjectDoc.started(doc)
    val paused = doc.text("pausedAt") != null
    val webUrl = "${handle.account.server.trimEnd('/')}/projects/${doc.text("id") ?: id}"
    LazyColumn(Modifier.fillMaxSize().testTag("project-detail"), state = listState, contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 32.dp)) {
        item(key = "header") { Header(state, doc, now, connected, menu = {
            Box {
                TextButton(onClick = { menu = true }, enabled = !state.busy, modifier = Modifier.testTag("project-menu").semantics { contentDescription = "Project actions" }) {
                    Text("⋯", style = MaterialTheme.typography.titleLarge) }
                DropdownMenu(menu, { menu = false }) {
                    if (status == "OPEN") {
                        DropdownMenuItem(text = { Text("Record as done") }, enabled = enabled, onClick = { menu = false; dialog = ProjectDialog.Status("DONE") })
                        DropdownMenuItem(text = { Text("Record as cancelled") }, enabled = enabled, onClick = { menu = false; dialog = ProjectDialog.Status("CANCELLED") })
                    } else DropdownMenuItem(text = { Text("Reopen project") }, enabled = enabled, onClick = { menu = false; dialog = ProjectDialog.Status("OPEN") })
                    HorizontalDivider()
                    DropdownMenuItem(text = { Text(SharePanelCopy.copyLink) }, onClick = { menu = false; clipboard.setText(AnnotatedString(webUrl)); state.copied = SharePanelCopy.linkCopied })
                    DropdownMenuItem(text = { Column { Text(SharePanelCopy.share); SharePanel.menuStatus(state.share)?.let { Text(it, style = MaterialTheme.typography.bodySmall) } } },
                        onClick = { menu = false; dialog = ProjectDialog.Share })
                    DropdownMenuItem(text = { Text(SharePanelCopy.copyAsMarkdown) }, onClick = {
                        menu = false; clipboard.setText(AnnotatedString(ProjectMarkdown.project(doc, webUrl, state.panorama?.obj("buckets"), state.tasks)))
                        state.copied = SharePanelCopy.markdownCopied
                    })
                    HorizontalDivider()
                    DropdownMenuItem(text = { Text(ProjectPage.deletePress, color = MaterialTheme.colorScheme.error) }, enabled = enabled && ProjectDoc.taskCount(doc) == 0,
                        onClick = { menu = false; dialog = ProjectDialog.Delete })
                }
            }
        }) }
        openItemsSection(state, doc, now, enabled, startOwn = { dialog = ProjectDialog.Start }, review = { openCoordinator() }, perform = { action, row ->
            when (action) {
                "RESUME" -> row.text("fuseEpisodeId")?.let { episode -> write("Couldn't resume the coordinator: ") { api.resumeFuse(id, episode) } }
                "OPEN_TASK_SESSION" -> row.text("sessionId")?.let { open(OrbitRoute(Destination.SESSION, it)) } ?: row.text("taskId")?.let(openTask)
                "OPEN_COORDINATOR" -> row.obj("delivery")?.text("sessionId")?.let { open(OrbitRoute(Destination.SESSION, it)) } ?: openCoordinator()
                else -> openCoordinator()
            }
        })
        overviewSection(state, doc, now, openTask)
        coordinatorSection(state, doc, now, enabled, openCoordinator = { openCoordinator() }, replace = { finished ->
            if (finished) replaceCoordinator() else dialog = ProjectDialog.Replace })
        if (started != false) item(key = "runs") {
            RunSettingsSection(state, doc, now, enabled, editMergeCheck = { dialog = ProjectDialog.MergeCheck },
                integration = { body -> if (body != null && body.isNotEmpty()) write("${RunSettings.notSaved} — ") { api.updateIntegration(id, body, revision(doc) + body) } },
                automatic = { next ->
                    val body = RunSettings.authorization(doc, automatic = next)
                    if (body == null) state.notice = "${RunSettings.notSaved} — reload the project and try again."
                    else write("${RunSettings.notSaved} — ") { api.authorize(id, body) }
                },
                stepConcurrency = { stepConcurrency(it) },
                pause = { next -> write("${if (next) RunSettings.notPaused else RunSettings.notResumed} — ") { api.pause(id, next, revision(doc)) } })
        }
        doc.text("goal")?.trim()?.takeIf { it.isNotEmpty() }?.let { goal -> item(key = "goal") { SectionHead("Goal"); Folded(goal, 132, link) } }
        state.graph?.takeIf { it.objects("marks").isNotEmpty() }?.let { graph -> item(key = "graph") {
            SectionHead("Task graph", "Prerequisite → dependent"); ProjectGraph(graph, openTask)
        } }
        blockersSection(doc, now, enabled) { dialog = ProjectDialog.Resolve(it) }
        queueSection(state, enabled, open, run = { item ->
            val taskId = item.text("taskId") ?: return@queueSection
            val trigger = UUID.randomUUID().toString()
            state.starting = state.starting + taskId
            write("Couldn't start the task: ") {
                try { api.run(taskId, trigger, "${taskId}:${item.text("status")}:${item.text("runState")}") } finally { state.starting = state.starting - taskId }
            }
        }, resume = { dialog = ProjectDialog.ResumeList(it) })
        criteriaSection(doc, openTask)
        item(key = "instructions") {
            SectionHead(ProjectPage.instructionsHeading)
            doc.text("instructions")?.trim()?.takeIf { it.isNotEmpty() }?.let { Folded(it, 180, link) }
                ?: Text(ProjectPage.noInstructions, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        tasksSection(state, doc, openTask, loadMore = {
            val cursor = state.cursor ?: return@tasksSection
            if (state.loadingMore || state.refreshing) return@tasksSection
            state.loadingMore = true
            scope.launch {
                try {
                    val page = api.tasks(id, cursor)
                    val known = state.tasks.mapNotNull { it.text("id") }.toSet()
                    state.tasks = state.tasks + page.objects("items").filter { it.text("id") !in known }
                    state.cursor = page.text("nextCursor")
                } catch (cancel: CancellationException) { throw cancel } catch (_: Exception) { } finally { state.loadingMore = false }
            }
        })
    }

    state.notice?.let { message -> AlertDialog(onDismissRequest = { state.notice = null }, title = { Text("Couldn't do that") }, text = { Text(message) },
        confirmButton = { TextButton(onClick = { state.notice = null }, modifier = Modifier.testTag("project-notice-ok")) { Text("OK") } }, modifier = Modifier.testTag("project-notice")) }
    when (val current = dialog) {
        null -> Unit
        is ProjectDialog.Status -> AlertDialog(onDismissRequest = { dialog = null }, title = { Text(ProjectPage.confirmTitle(current.status, doc.text("title") ?: "this project")) },
            text = { Text(ProjectPage.confirmMessage(current.status, doc, state.panorama?.obj("buckets"))) },
            confirmButton = { TextButton(onClick = { dialog = null; write("Couldn't change the project's status: ") { api.setStatus(id, current.status, revision(doc)) } },
                enabled = enabled, modifier = Modifier.testTag("project-status-confirm")) {
                Text(ProjectPage.confirmButton(current.status), color = if (current.status == "CANCELLED") MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.primary) } },
            dismissButton = { TextButton(onClick = { dialog = null }) { Text("Cancel") } })
        ProjectDialog.Delete -> AlertDialog(onDismissRequest = { dialog = null }, title = { Text(ProjectPage.deleteTitle) }, text = { Text(ProjectPage.deleteMessage) },
            confirmButton = { TextButton(onClick = { dialog = null; write("Couldn't delete the project: ") { api.delete(id); state.missing = true; state.document = null } },
                enabled = enabled, modifier = Modifier.testTag("project-delete-confirm")) {
                Text(ProjectPage.deletePress, color = MaterialTheme.colorScheme.error) } },
            dismissButton = { TextButton(onClick = { dialog = null }) { Text("Cancel") } })
        ProjectDialog.Replace -> AlertDialog(onDismissRequest = { dialog = null }, title = { Text(ProjectPage.replaceCoordinatorQuestion) }, text = { Text(ProjectPage.replaceCoordinatorDetail) },
            confirmButton = { TextButton(onClick = { dialog = null; replaceCoordinator() }, enabled = enabled, modifier = Modifier.testTag("project-replace-confirm")) {
                Text(ProjectPage.replaceCoordinatorConfirm, color = MaterialTheme.colorScheme.error) } },
            dismissButton = { TextButton(onClick = { dialog = null }) { Text(ProjectPage.replaceCoordinatorKeep) } })
        is ProjectDialog.Resolve -> {
            var reason by rememberSaveable(current.blocker.text("id")) { mutableStateOf("") }
            AlertDialog(onDismissRequest = { dialog = null }, title = { Text(ProjectPage.resolveBlockerTitle(current.blocker)) },
                text = { Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(ProjectPage.resolveBlockerMessage(current.blocker), style = MaterialTheme.typography.bodySmall)
                    OutlinedTextField(reason, { reason = it.take(ProjectPage.blockerReasonLimit) }, Modifier.fillMaxWidth().testTag("blocker-reason"),
                        label = { Text(ProjectPage.resolveBlockerQuestion(current.blocker)) })
                } },
                confirmButton = { TextButton(onClick = {
                    dialog = null
                    val blockerId = current.blocker.text("id") ?: return@TextButton
                    write("Couldn't resolve the blocker: ") { api.resolveBlocker(id, blockerId, reason.trim()) }
                }, enabled = enabled && reason.isNotBlank(), modifier = Modifier.testTag("blocker-resolve-confirm")) { Text(ProjectPage.resolveBlockerConfirm(current.blocker)) } },
                dismissButton = { TextButton(onClick = { dialog = null }) { Text(ProjectPage.resolveBlockerKeep(current.blocker)) } })
        }
        is ProjectDialog.ResumeList -> AlertDialog(onDismissRequest = { dialog = null },
            title = { Text(current.item.obj("pausedList")?.let(ProjectPage::resumeListQuestion).orEmpty()) }, text = { Text(ProjectPage.resumeListDetail(current.item)) },
            confirmButton = { TextButton(onClick = {
                dialog = null
                val listId = current.item.obj("pausedList")?.text("id") ?: return@TextButton
                write("Couldn't resume the task list: ") { api.resumeList(listId) }
            }, enabled = enabled) { Text(ProjectPage.resumeListPress) } },
            dismissButton = { TextButton(onClick = { dialog = null }) { Text("Cancel") } })
        ProjectDialog.Start -> OwnerStartSheet(api, id, state, enabled, viewTasks = {
            dialog = null
            scope.launch { delay(300); listState.animateScrollToItem(maxOf(0, listState.layoutInfo.totalItemsCount - tasksTail(state))) }
        }, close = { dialog = null }) { body -> attempt("${StartProjectCopy.notRecorded} — ") { api.start(id, body) } }
        ProjectDialog.MergeCheck -> state.integration?.let { view ->
            MergeCheckEditor(view, doc.flag("coordinatorEnabled"), enabled, close = { dialog = null }) { body ->
                if (body == null || body.isEmpty()) null else attempt("${RunSettings.notSaved} — ") { api.updateIntegration(id, body, revision(doc) + body) }
            }
        } ?: run { dialog = null }
        ProjectDialog.Share -> ShareSheet(app, handle, ShareRootKind.PROJECT, id, close = { dialog = null }) { state.share = it }
    }
}

@Composable
private fun Header(state: ProjectPageState, doc: JsonObject, now: Instant, connected: Boolean, menu: @Composable () -> Unit) {
    Column(Modifier.padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.Top) {
            Text(doc.text("title").orEmpty(), Modifier.weight(1f), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
            menu()
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            val running = ProjectDoc.status(doc) == "OPEN" && ProjectDoc.started(doc) != false
            Chip(ProjectDoc.statusLabel(doc), if (running) TagTone.BRAND else TagTone.NEUTRAL, Modifier.testTag("project-status"))
            val count = ProjectDoc.taskCount(doc)
            Text("$count task${if (count == 1) "" else "s"}", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        val view = state.integration
        val facts = view?.let { ProjectPage.integrationFacts(it, now) }
        when {
            facts != null -> Text("${if (view.text("line") == "PROJECT_BRANCH") "⎇" else "↓"} ${facts.joinToString(" · ")}", Modifier.testTag("project-integration-facts"),
                style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            view != null && view["line"].let { it == null || it is JsonNull } && ProjectDoc.started(doc) == false ->
                Text("⎇ ${RunSettings.undecidedLine(state.openItems?.obj("startRequest")?.obj("startRequest")?.obj("settings")?.text("line"))}",
                    style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (!connected) OfflineNote()
        state.copied?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = LocalOrbitColors.current.success) }
    }
}

private fun LazyListScope.openItemsSection(state: ProjectPageState, doc: JsonObject, now: Instant, enabled: Boolean, startOwn: () -> Unit, review: () -> Unit,
    perform: (String, JsonObject) -> Unit) {
    val items = state.openItems ?: return
    val start = if (ProjectDoc.status(doc) == "OPEN" && ProjectDoc.started(doc) == false) (items.obj("startRequest") ?: JsonObject(emptyMap())) else null
    val asked = start?.takeIf { it.isNotEmpty() }
    val needsYou = items.objects("needsYou")
    val withCoordinator = items.objects("withCoordinator")
    if (needsYou.isEmpty() && withCoordinator.isEmpty() && start == null) return
    item(key = "open-items-head") { SectionHead(ProjectPage.openItemsHeading, ProjectPage.openItemsHint(needsYou.size + if (asked != null) 1 else 0, withCoordinator.size)) }
    if (needsYou.isNotEmpty() || start != null) {
        item(key = "needs-you") { GroupLabel(ProjectPage.needsYouGroup) }
        if (start != null) item(key = "start-row") {
            if (asked != null) ItemRow(StartProjectCopy.title, asked.obj("startRequest")?.obj("settings")?.let(StartProjectCopy::requestSummary) ?: asked.text("detailLine").orEmpty(),
                "${ProjectPage.who(asked)} · ${ProjectPage.waitingLabel(asked, now)}", true, ProjectPage.actionLabel("REVIEW"), enabled, tag = "start-request", press = review, tap = review)
            else Row(Modifier.fillMaxWidth().clickable(enabled = enabled, role = Role.Button, onClick = startOwn).padding(vertical = 8.dp).testTag("project-start-own"),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Box(Modifier.size(8.dp).background(MaterialTheme.colorScheme.outline, CircleShape))
                Column(Modifier.weight(1f)) {
                    Text(StartProjectCopy.rowOwn, color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.SemiBold)
                    Text(StartProjectCopy.rowNotAsked, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Text("›", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
        items(needsYou, key = { "item:${it.text("itemId")}" }) { row ->
            val action = ProjectPage.primaryAction(row)
            ItemRow(row.text("title").orEmpty(), row.text("detailLine").orEmpty(), "${ProjectPage.who(row)} · ${ProjectPage.waitingLabel(row, now)}", true,
                action?.let(ProjectPage::actionLabel), enabled, tag = "item:${row.text("itemId")}", press = { action?.let { perform(it, row) } }, tap = { perform("REVIEW", row) })
        }
    }
    if (withCoordinator.isNotEmpty()) {
        item(key = "with-coordinator") { GroupLabel(ProjectPage.withCoordinatorGroup) }
        items(withCoordinator, key = { "coordinator-item:${it.text("itemId")}" }) { row ->
            val action = ProjectPage.primaryAction(row)
            ItemRow(row.text("title").orEmpty(), row.text("detailLine").orEmpty(), "${ProjectPage.who(row)} · ${ProjectPage.waitingLabel(row, now)}", false,
                action?.let(ProjectPage::actionLabel), enabled, tag = "item:${row.text("itemId")}", press = { action?.let { perform(it, row) } }, tap = { perform("OPEN_COORDINATOR", row) })
        }
    }
}

@Composable
private fun GroupLabel(text: String) = Text(text.uppercase(), Modifier.padding(top = 6.dp), style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold,
    color = MaterialTheme.colorScheme.onSurfaceVariant)

@Composable
private fun ItemRow(title: String, detail: String, meta: String, owner: Boolean, action: String?, enabled: Boolean, tag: String, press: () -> Unit, tap: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(enabled = enabled, role = Role.Button, onClick = tap).padding(vertical = 6.dp).testTag(tag),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Box(Modifier.size(8.dp).background(if (owner) LocalOrbitColors.current.needsYou else MaterialTheme.colorScheme.primary, CircleShape))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, fontWeight = FontWeight.SemiBold, maxLines = 3)
            if (detail.isNotEmpty()) Text(detail, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 3)
            Text(meta, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        action?.let { label -> Button(onClick = press, enabled = enabled, modifier = Modifier.testTag("$tag:action"),
            colors = if (owner) ButtonDefaults.buttonColors() else ButtonDefaults.filledTonalButtonColors()) { Text(label) } }
    }
}

private fun LazyListScope.overviewSection(state: ProjectPageState, doc: JsonObject, now: Instant, openTask: (String) -> Unit) {
    val panorama = state.panorama ?: return
    val buckets = panorama.obj("buckets") ?: JsonObject(emptyMap())
    val status = ProjectDoc.status(doc)
    val started = ProjectDoc.started(doc)
    val paused = doc.text("pausedAt") != null
    val manual = if ((buckets.number("ready") ?: 0) > 0) ProjectPage.manualReady(if (state.queueUnread) null else state.queue, status, started, paused) else null
    val cells = ProjectPage.overviewCells(buckets, panorama.obj("shape")?.number("taskCount") ?: ProjectDoc.taskCount(doc), doc.obj("integration")?.text("line"),
        started, paused, manual?.number("count") ?: 0)
    item(key = "overview") {
        SectionHead("Work overview", panorama.obj("shape")?.let(ProjectPage::overviewSubtitle))
        Column(Modifier.testTag("project-overview"), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            state.integration?.let { view -> ProjectPage.landingLine(view, now, state.integrationReadAt, state.integrationReadFailed)?.let { LandingRow(it) } }
            cells.chunked(2).forEach { pair -> Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                pair.forEach { cell -> Column(Modifier.weight(1f).testTag("overview:${cell.key}")) {
                    Text("${glyphText(cell.glyph)} ${cell.label}", style = MaterialTheme.typography.labelMedium,
                        color = if (cell.key == "ready" || cell.key == "integrating") MaterialTheme.colorScheme.onSurface else glyphColor(cell.glyph))
                    Text("${cell.value}", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
                    Text(cell.footnote, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                } }
                if (pair.size == 1) Spacer(Modifier.weight(1f))
            } }
            Meter(cells.map { it.value to (if (it.key == "ready" || it.key == "integrating") MaterialTheme.colorScheme.outline else glyphColor(it.glyph)) }, height = 8)
            manual?.let { ready -> Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(8.dp)).padding(10.dp).testTag("manual-ready"),
                verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("▶ ${ProjectPage.manualReadyTitle}", fontWeight = FontWeight.SemiBold)
                Text(ProjectPage.manualReadySentence(ready.number("count") ?: 0), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text("${ready.text("title").orEmpty()} ›", Modifier.clickable { ready.text("taskId")?.let(openTask) }, style = MaterialTheme.typography.labelMedium)
                OutlinedButton(onClick = { ready.text("taskId")?.let(openTask) }) { Text(ProjectPage.manualReadyPress) }
            } }
            if (ProjectPage.wrappingUp(status, buckets, state.integration?.obj("inFlight"))) Column(Modifier.fillMaxWidth()
                .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.08f), RoundedCornerShape(8.dp)).padding(10.dp).testTag("wrap-up")) {
                Text("✓ ${ProjectPage.wrapUpTitle}", fontWeight = FontWeight.SemiBold)
                Text(ProjectPage.wrapUpSentence((buckets.number("done") ?: 0) + (buckets.number("cancelled") ?: 0)), style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

/** The landing in flight (ProjectLandingRow.swift): what the platform is doing while the counts stand still. */
@Composable
private fun LandingRow(line: LandingLine) {
    Row(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(8.dp)).padding(10.dp).testTag("landing-row"),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        if (line.running) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp) else Text("◌", color = MaterialTheme.colorScheme.onSurfaceVariant)
        Column(Modifier.weight(1f)) {
            Text(listOfNotNull(line.word, line.what).joinToString(" · "), fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis,
                color = if (line.running) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface)
            Text(listOfNotNull(line.state, line.updated).joinToString(" · "), style = MaterialTheme.typography.labelMedium,
                color = if (line.running) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Column(horizontalAlignment = Alignment.End) {
            Text(line.clockLabel, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(line.clock, style = MaterialTheme.typography.labelLarge)
        }
    }
}

private fun LazyListScope.coordinatorSection(state: ProjectPageState, doc: JsonObject, now: Instant, enabled: Boolean, openCoordinator: () -> Unit, replace: (Boolean) -> Unit) {
    val status = state.coordinator ?: return
    val pill = ProjectPage.coordinatorPill(status)
    val coordination = status.obj("coordination") ?: JsonObject(emptyMap())
    val finished = ProjectPage.coordinatorFinished(status)
    item(key = "coordinator") {
        SectionHead("Coordinator") { Chip(pill.label, pill.tone, Modifier.testTag("coordinator-pill")) }
        Column(Modifier.testTag("project-coordinator-section"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            coordination.obj("session")?.let { session -> Column {
                Text(session.text("title") ?: "Coordinator", fontWeight = FontWeight.SemiBold)
                Text(listOfNotNull(ProjectPage.lastActive(session, status.text("readAt")), ProjectPage.coordinatorOrdinal(coordination.text("coordinatorGeneration"))).joinToString(" · "),
                    style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (status.text("state") == "LIVE" && finished) Text(ProjectPage.finishedCoordinatorNote, style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(top = 4.dp))
            } }
            coordination.text("workspaceName")?.let { Labeled("Workspace", it) }
            coordination.obj("wakeups")?.let { Labeled("Wake-ups", ProjectPage.wakeupsLine(it, now)) }
            coordination.obj("fuse")?.let { fuse -> Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Labeled("Self-started today", ProjectPage.selfStartedLine(fuse))
                ProjectPage.selfStartedFraction(fuse)?.let { LinearProgressIndicator(progress = { it }, Modifier.fillMaxWidth(),
                    color = if (fuse.flag("paused")) LocalOrbitColors.current.needsYou else MaterialTheme.colorScheme.primary) }
            } }
            if (status.text("state") == "UNAVAILABLE") status.obj("openability")?.text("requiredAction")?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.error) }
            if (status.text("state") == "LIVE" && coordination.obj("session") != null) {
                val open = doc.obj("tasksByStatus")?.let { (it.number("OPEN") ?: 0) }
                val (heading, text) = ProjectPage.dispatchNote(open, finished)
                Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(10.dp)).padding(10.dp)) {
                    Text(heading, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(text, style = MaterialTheme.typography.labelMedium)
                }
                // The lead press is the safe one; starting the next coordinator is a one-way door, held behind the menu.
                var more by remember { mutableStateOf(false) }
                Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                    Button(onClick = openCoordinator, Modifier.weight(1f).testTag("project-coordinator"), enabled = enabled) {
                        Text(ProjectPage.coordinatorPress(finished, pill.label == "Needs you")) }
                    Box {
                        FilledTonalButton(onClick = { more = true }, enabled = enabled, contentPadding = PaddingValues(horizontal = 12.dp),
                            modifier = Modifier.testTag("project-coordinator-more").semantics { contentDescription = "More coordinator actions" }) { Text("▾") }
                        DropdownMenu(more, { more = false }) {
                            DropdownMenuItem(text = { Column(Modifier.widthIn(max = 300.dp)) {
                                Text(ProjectPage.startNewCoordinator)
                                Text(ProjectPage.startNewCoordinatorDetail(finished), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            } }, onClick = { more = false; replace(finished) }, modifier = Modifier.testTag("project-coordinator-replace"))
                        }
                    }
                }
            } else if (status.obj("openability")?.flag("canOpen") == true) Button(onClick = openCoordinator, Modifier.fillMaxWidth().testTag("project-coordinator"), enabled = enabled) {
                Text(if (status.text("state") == "NEVER_OPENED") "Start coordinator" else "Start a new coordinator") }
        }
    }
}

@Composable
internal fun Labeled(label: String, value: String) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(label); Spacer(Modifier.weight(1f)); Text(value, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2)
    }
}

/** A Markdown block shown to a height, with More / Less (`folded`). */
@Composable
private fun Folded(source: String, height: Int, link: (String) -> Unit) {
    var expanded by rememberSaveable(source) { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Box(Modifier.then(if (expanded) Modifier else Modifier.heightIn(max = height.dp))) { MarkdownText(source, open = link) }
        TextButton(onClick = { expanded = !expanded }) { Text(if (expanded) "Less" else "More") }
    }
}

private fun LazyListScope.blockersSection(doc: JsonObject, now: Instant, enabled: Boolean, resolve: (JsonObject) -> Unit) {
    val blockers = doc.obj("blockers") ?: return
    val open = blockers.objects("open")
    if (open.isEmpty()) return
    item(key = "blockers-head") { SectionHead("Blockers", ProjectPage.blockersOpen(open.size)) }
    items(open, key = { "blocker:${it.text("id")}" }) { blocker ->
        val headline = ProjectPage.blockerHeadline(blocker)
        Column(Modifier.fillMaxWidth().padding(vertical = 6.dp).testTag("blocker:${blocker.text("id")}"), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Chip(headline.tag, headline.tone)
                Text(headline.title, Modifier.weight(1f), style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(ProjectPage.blockerSince(blocker.text("firstSeenAt"), now), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    ProjectPage.blockerSubjectLine(blocker)?.let { Text(it, maxLines = 2) }
                    ProjectPage.blockerDecision(blocker)?.let { Text(it.question, fontWeight = FontWeight.SemiBold) }
                    Text(blocker.text("requiredAction").orEmpty(), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    ProjectPage.blockerPathsLine(blocker.obj("detail")?.strings("paths").orEmpty())?.let {
                        Text(it, fontFamily = FontFamily.Monospace, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1) }
                }
                OutlinedButton(onClick = { resolve(blocker) }, enabled = enabled, modifier = Modifier.testTag("blocker:${blocker.text("id")}:resolve")) {
                    Text(ProjectPage.resolveBlockerPress(blocker)) }
            }
        }
    }
    ProjectPage.blockersResolvedSummary(blockers)?.let { summary -> item(key = "blockers-resolved") {
        var open by rememberSaveable { mutableStateOf(false) }
        Column {
            Text("${if (open) "▾" else "▸"} $summary", Modifier.clickable { open = !open }, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            if (open) blockers.objects("resolved").forEach { Text(ProjectPage.blockerResolvedLine(it), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
    } }
}

private fun LazyListScope.queueSection(state: ProjectPageState, enabled: Boolean, open: (OrbitRoute) -> Unit, run: (JsonObject) -> Unit, resume: (JsonObject) -> Unit) {
    val queue = state.queue ?: return
    item(key = "queue-head") { SectionHead("Run queue", ProjectPage.queueSummary(queue)) }
    queue.obj("impactTruncated")?.number("maxTasks")?.let { max -> item(key = "queue-truncated") {
        val (title, detail) = ProjectPage.queueImpactTruncated(max)
        Text("⚠ $title. $detail", style = MaterialTheme.typography.labelMedium, color = LocalOrbitColors.current.needsYou)
    } }
    if (queue.objects("items").isEmpty()) item(key = "queue-empty") { Text(ProjectPage.queueEmpty, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    items(queue.objects("items"), key = { "queue:${it.text("taskId")}" }) { item ->
        Row(Modifier.fillMaxWidth().padding(vertical = 6.dp).testTag("queue:${item.text("taskId")}"), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text(item.text("title").orEmpty(), maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.clickable { item.text("taskId")?.let { open(OrbitRoute(Destination.TASK, it)) } })
                val mark = when (item.text("runState")) { "READY" -> "✓"; "RUNNING" -> "◌"; "QUEUED" -> "◷"; else -> "⏸" }
                Text("$mark ${ProjectPage.queueRowState(item)}", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(ProjectPage.queueImpact(item), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            when {
                item.text("runState") == "READY" -> FilledTonalButton(onClick = { run(item) }, enabled = enabled, modifier = Modifier.testTag("queue:${item.text("taskId")}:run")
                    .semantics { contentDescription = "Run ${item.text("title").orEmpty()}" }) {
                    Text("▶ ${if (item.text("taskId") in state.starting) ProjectPage.runPressStarting else ProjectPage.runPress}") }
                item.text("runState") == "PAUSED" && item.obj("pausedList") != null -> OutlinedButton(onClick = { resume(item) }, enabled = enabled) { Text(ProjectPage.resumeListPress) }
                item.text("runState") in setOf("RUNNING", "QUEUED") && item.text("sessionId") != null -> TextButton(onClick = {
                    item.text("sessionId")?.let { open(OrbitRoute(Destination.SESSION, it)) } }) { Text(ProjectPage.openRunSession) }
                else -> Chip(ProjectPage.queueRowTag(item.text("runState")), TagTone.NEUTRAL)
            }
        }
    }
    if (queue.objects("items").isNotEmpty()) item(key = "queue-help") { Text(ProjectPage.queueHelp(queue), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
}

private fun LazyListScope.criteriaSection(doc: JsonObject, openTask: (String) -> Unit) {
    val criteria = doc.objects("acceptanceCriteriaItems").sortedBy { it.number("ordinal") ?: 0 }
    item(key = "criteria-head") { SectionHead("Acceptance criteria") }
    if (criteria.isEmpty()) { item(key = "criteria-empty") { Text(ProjectPage.noCriteria, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }; return }
    item(key = "criteria") {
        var expanded by rememberSaveable { mutableStateOf(false) }
        val limit = ProjectPage.criteriaPreviewCompact
        Column(Modifier.testTag("project-criteria"), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            Text(ProjectPage.criteriaStanding(criteria.size), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            (if (expanded) criteria else criteria.take(limit)).forEach { criterion -> CriterionRow(criterion, doc.obj("integration")?.text("ref"), openTask) }
            ProjectPage.criteriaDisclosure(criteria.size, limit, expanded)?.let { (press, meta) ->
                OutlinedButton(onClick = { expanded = !expanded }, Modifier.fillMaxWidth()) { Text(press) }
                Text(meta, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.align(Alignment.CenterHorizontally))
            }
            Text(ProjectPage.criteriaOutcomeNote, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun CriterionRow(criterion: JsonObject, ref: String?, openTask: (String) -> Unit) {
    var method by rememberSaveable(criterion.text("id")) { mutableStateOf(false) }
    val satisfied = ProjectDoc.satisfied(criterion)
    Row(Modifier.fillMaxWidth().testTag("criterion:${criterion.number("ordinal")}"), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        val success = LocalOrbitColors.current.success
        Box(Modifier.size(22.dp).then(when (satisfied) {
            true -> Modifier.background(success, CircleShape)
            false -> Modifier.border(1.5.dp, MaterialTheme.colorScheme.onSurface.copy(alpha = 0.7f), CircleShape)
            null -> Modifier.border(1.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.6f), CircleShape)
        }), contentAlignment = Alignment.Center) {
            Text("${criterion.number("ordinal") ?: ""}", style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold,
                color = if (satisfied == true) Color.White else MaterialTheme.colorScheme.onSurface)
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(criterion.text("text").orEmpty())
            ProjectPage.criterionWork(criterion, ref)?.let { work ->
                Text(buildString {
                    append(work.state); work.landing?.let { append(" · $it") }; work.landingWarning?.let { append(" · $it") }
                }, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold,
                    color = if (satisfied == true) success else MaterialTheme.colorScheme.onSurface)
                work.reasons.forEach { reason ->
                    Text(reason.sentence, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    reason.heldUpBy.forEach { held -> Text("${held.title} — ${held.action}", Modifier.clickable { openTask(held.taskId) }.testTag("held-up:${held.taskId}"),
                        style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary) }
                }
            }
            criterion.text("verificationMethod")?.takeIf { it.isNotEmpty() }?.let { text ->
                Text("${if (method) "▾" else "▸"} ${ProjectPage.howItsChecked}", Modifier.clickable { method = !method }, style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.primary)
                if (method) Text(text, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

/** How many rows the Tasks section draws, its head included: "View tasks ›" lands on that head. */
private fun tasksTail(state: ProjectPageState): Int =
    1 + ProjectPage.taskGroups(state.tasks).let { groups -> if (groups.isEmpty()) 1 else groups.sumOf { 1 + it.tasks.size } } + if (state.cursor != null) 1 else 0

private fun LazyListScope.tasksSection(state: ProjectPageState, doc: JsonObject, openTask: (String) -> Unit, loadMore: () -> Unit) {
    val groups = ProjectPage.taskGroups(state.tasks)
    item(key = "tasks-head") { SectionHead("Tasks", "${ProjectDoc.taskCount(doc)}") }
    if (groups.isEmpty()) item(key = "tasks-empty") { Text("No tasks yet.", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    groups.forEach { group ->
        item(key = "group:${group.key}") { GroupLabel(group.heading) }
        items(group.tasks, key = { "task:${group.key}:${it.text("id")}" }) { task ->
            val tags = ProjectPage.rowTags(task, group.heading, doc.obj("integration")?.text("ref"), doc.obj("integration")?.text("upstreamRef"))
            Row(Modifier.fillMaxWidth().clickable(role = Role.Button) { task.text("id")?.let(openTask) }.padding(vertical = 6.dp).testTag("project-task:${task.text("id")}"),
                verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                val glyph = ProjectPage.taskGlyph(task)
                Text(glyphText(glyph), color = glyphColor(glyph))
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
                    Text(task.text("title").orEmpty(), maxLines = 2, color = if (group.settled) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface)
                    val unmet = task.number("unmetCount") ?: 0; val blocks = task.number("blocksCount") ?: 0
                    if (tags.isNotEmpty() || unmet > 0 || blocks > 0) Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
                        tags.forEach { Chip(it.text, it.tone) }
                        if (unmet > 0) Text("waits $unmet", style = MaterialTheme.typography.labelSmall, color = LocalOrbitColors.current.needsYou)
                        if (blocks > 0) Text("blocks $blocks", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                    }
                }
                Text("›", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
    if (state.cursor != null) item(key = "tasks-more") {
        TextButton(onClick = loadMore, enabled = !state.loadingMore, modifier = Modifier.fillMaxWidth()) { if (state.loadingMore) CircularProgressIndicator(Modifier.size(16.dp)) else Text("Load more tasks") }
    }
}
