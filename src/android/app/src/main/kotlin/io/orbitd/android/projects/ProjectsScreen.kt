package io.orbitd.android.projects

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
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
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.orbitd.android.OrbitApplication
import io.orbitd.android.R
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.cards.*
import io.orbitd.android.core.net.ApiError
import io.orbitd.android.navigation.*
import io.orbitd.android.cards.CardFocus
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
        if (detail != null) Text(detail, Modifier.weight(1f), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 2, overflow = TextOverflow.Ellipsis)
        else Spacer(Modifier.weight(1f))
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
    // Live events are coalesced as iOS `ProjectsModel.nudge` does — one read two seconds after the first of a burst, never
    // cancelled by the next — and the index is read again every 15 s while it is shown (`refreshIfDue`).
    val nudge = remember(handle) { RefreshNudge(scope) { if (projects != null) load() } }
    LaunchedEffect(handle, revision) { if (revision > 0) nudge.nudge() }
    LaunchedEffect(handle) { while (true) { delay(15_000); if (projects != null && !loading) load() } }
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
    /** A failed first read must not leave the Open items sheet spinning or claim there are none. */
    var openItemsUnread by mutableStateOf(false)
    var coordinator by mutableStateOf<JsonObject?>(null)
    var graph by mutableStateOf<JsonObject?>(null)
    var queue by mutableStateOf<JsonObject?>(null)
    var queueUnread by mutableStateOf(false)
    var tasks by mutableStateOf<List<JsonObject>>(emptyList())
    var cursor by mutableStateOf<String?>(null)
    var loadingMore by mutableStateOf(false)
    var share by mutableStateOf<JsonObject?>(null)
    /** What has been asked about work crossing into or out of this project (`ProjectCrossings`); unread only while no read has answered. */
    var crossings by mutableStateOf<List<JsonObject>?>(null)
    var crossingsUnread by mutableStateOf(false)
    /** The crossing an answer is on its way for: its row says so and takes no second press, and no other row takes one either. */
    var answeringCrossing by mutableStateOf<String?>(null)
    var busy by mutableStateOf(false)
    /** At most as the stepper has it while the write it will make waits for the presses to stop. */
    var pendingConcurrency by mutableStateOf<Int?>(null)
    var starting by mutableStateOf<Set<String>>(emptySet())
    var notice by mutableStateOf<String?>(null)
    var copied by mutableStateOf<String?>(null)
    var refreshing = false
    /** Whether the page is still shown: a write that outlives it finishes, but reads and opens nothing. */
    var attached = true
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
    data object Done : ProjectDialog
    data object OpenItems : ProjectDialog
    data object LandingJobs : ProjectDialog
}

@Composable
private fun ProjectDetail(app: OrbitApplication, handle: SessionHandle, id: String, revision: Long, open: (OrbitRoute) -> Unit, back: () -> Unit) {
    val api = remember(handle) { ProjectApi(app.session, handle) { app.canWrite(handle) } }
    val state = remember(handle, id) { ProjectPageState() }
    DisposableEffect(state) { state.attached = true; onDispose { state.attached = false } }
    val scope = rememberCoroutineScope()
    val live by app.realtime.state.collectAsState()
    val auth by app.session.state.collectAsState()
    val connected = writable(live, handle, (auth as? AuthState.SignedIn)?.handle)
    val clipboard = LocalClipboardManager.current
    val resources = LocalReaderResources.current ?: remember(handle) { ReaderResources(app.session, handle) }
    val link = rememberReaderLinkHandler(resources, open)
    var dialog by remember { mutableStateOf<ProjectDialog?>(null) }
    // The crossing whose second press is showing, and the answer it would give (true: approve) — one at a time — and the door's
    // refusal of that answer, on the row it was given on.
    var crossingAsk by remember { mutableStateOf<Pair<String, Boolean>?>(null) }
    var crossingRefusal by remember { mutableStateOf<Pair<String, ProjectCrossings.Refusal>?>(null) }
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
                val crossings = async { runCatching { api.crossings(id) }.getOrNull() }
                document.await().onSuccess { state.document = it; state.missing = false; state.loadFailed = false }.onFailure { failure ->
                    if (failure is CancellationException) throw failure
                    if (failure is ApiError && failure.status in setOf(403, 404)) { state.missing = true; state.document = null } else state.loadFailed = true
                }
                panorama.await()?.let { state.panorama = it }
                integration.await().let { if (it != null) { state.integration = it; state.integrationReadAt = Instant.now(); state.integrationReadFailed = false } else state.integrationReadFailed = true }
                openItems.await().let { if (it != null) { state.openItems = it; state.openItemsUnread = false } else state.openItemsUnread = state.openItems == null }
                coordinator.await()?.let { state.coordinator = it }
                graph.await()?.let { state.graph = it }
                queue.await().onSuccess { state.queue = it; state.queueUnread = false }.onFailure { if (it is CancellationException) throw it; state.queueUnread = true }
                tasks.await()?.let { (items, cursor) -> state.tasks = items; state.cursor = cursor }
                share.await()?.let { state.share = it }
                crossings.await().let { if (it != null) { state.crossings = it; state.crossingsUnread = false } else state.crossingsUnread = state.crossings == null }
            }
        } finally { state.refreshing = false }
    }
    LaunchedEffect(handle, id) { load() }
    // Live events are coalesced: one read two seconds after the first of a burst, never cancelled by the next.
    val nudge = remember(handle, id) { RefreshNudge(scope) { if (state.document != null) load() } }
    LaunchedEffect(handle, id, revision) { if (revision > 0) nudge.nudge() }
    // The visible page follows the work it shows, as the iOS page does, without its graph.
    LaunchedEffect(handle, id) { while (true) { delay(15_000); if (state.document != null) load(refreshGraph = false) } }
    LaunchedEffect(Unit) { while (true) { delay(1_000); now = Instant.now() } }
    LaunchedEffect(state.copied) { if (state.copied != null) { delay(2500); state.copied = null } }

    /** One write: busy while it is out, then the page read again; a refusal comes back as the sentence to show
     * (`write`/`runWrite`). The write belongs to the app, not to the page (iOS's model-owned Task): whoever
     * waits on it may go away — the page, a sheet — and it still finishes. */
    suspend fun attempt(refusal: String, body: suspend () -> Unit): String? {
        if (state.busy) return null
        state.busy = true
        return app.processScope.async {
            try { body(); null }
            catch (cancel: CancellationException) { throw cancel }
            catch (failure: Exception) { "$refusal${failureReason(failure)}." }
            finally {
                state.busy = false
                app.realtime.refreshDirectory()
                if (state.attached) load(settled = true)
            }
        }.await()
    }
    fun write(refusal: String, body: suspend () -> Unit) { app.processScope.launch { attempt(refusal, body)?.let { state.notice = it } } }
    var concurrencyWrite by remember { mutableStateOf<Job?>(null) }
    /** One press of At most: the number moves now, and one write goes once the presses stop (`stepConcurrency`),
     * even if the page is left before they have. */
    fun stepConcurrency(count: Int) {
        state.pendingConcurrency = count
        concurrencyWrite?.cancel()
        concurrencyWrite = app.processScope.launch {
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
    /** Open (or find) the coordinator conversation — onto the card of the owner's item when there is one
     * (iOS `openCoordinator(focus:)`), by the address that card is drawn under. */
    fun openCoordinator(focus: String? = null) {
        if (state.busy) return
        scope.launch {
            try {
                api.openCoordinator(id).text("sessionId")?.let { session ->
                    focus?.let { CardFocus.request(session, it) }
                    open(OrbitRoute(Destination.SESSION, session))
                }
            }
            catch (cancel: CancellationException) { throw cancel }
            catch (failure: Exception) { state.notice = "Couldn't open the coordinator: ${failureReason(failure)}." }
        }
    }
    fun replaceCoordinator() = write("Couldn't start a new coordinator: ") {
        api.replaceCoordinator(id, "replace:${state.coordinator?.obj("coordination")?.text("sessionId")}")?.text("sessionId")
            ?.let { if (state.attached) open(OrbitRoute(Destination.SESSION, it)) }
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
    // An open item's press, from the Open items sheet — which goes down first (iOS `perform`).
    val perform: (String, JsonObject) -> Unit = { action, row ->
        dialog = null
        val owners = row.text("assignee") != "COORDINATOR"
        val card = when {
            !owners -> null
            row.text("kind") == "PROMOTION_APPROVAL" -> "promotion:${row.text("promotionId").orEmpty()}"
            else -> row.text("itemId")?.let { "item:$it" }
        }
        when (action) {
            "RESUME" -> row.text("fuseEpisodeId")?.let { episode -> write("Couldn't resume the coordinator: ") { api.resumeFuse(id, episode) } }
            "OPEN_TASK_SESSION" -> row.text("sessionId")?.let { open(OrbitRoute(Destination.SESSION, it)) } ?: row.text("taskId")?.let(openTask)
            "OPEN_COORDINATOR" -> row.obj("delivery")?.text("sessionId")?.let { session ->
                card?.let { CardFocus.request(session, it) }; open(OrbitRoute(Destination.SESSION, session))
            } ?: openCoordinator(card)
            else -> openCoordinator(card)
        }
    }
    LazyColumn(Modifier.fillMaxSize().testTag("project-detail"), state = listState, contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 32.dp)) {
        item(key = "header") { Header(state, doc, now, connected, menu = {
            OpenItemsEntry(ProjectPage.openItemsSummary(doc, state.openItems), state.openItemsUnread) { dialog = ProjectDialog.OpenItems }
            Box {
                TextButton(onClick = { menu = true }, enabled = !state.busy, modifier = Modifier.testTag("project-menu").semantics { contentDescription = "Project actions" }) {
                    Text("⋯", style = MaterialTheme.typography.titleLarge) }
                DropdownMenu(menu, { menu = false }) {
                    if (status == "OPEN") {
                        DropdownMenuItem(text = { Text("Record as done") }, enabled = enabled, onClick = {
                            menu = false; dialog = if (ProjectDone.hasDoneDoor(doc)) ProjectDialog.Done else ProjectDialog.Status("DONE")
                        })
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
        openItemsAttention(state, doc, enabled, openSheet = { dialog = ProjectDialog.OpenItems }, startOwn = { dialog = ProjectDialog.Start })
        overviewSection(state, doc, now, openTask) { dialog = ProjectDialog.LandingJobs }
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
        // Last, where the web draws it (iOS `crossingsSection`).
        crossingsSection(state, connected, crossingAsk, crossingRefusal, ask = { row, approve -> crossingRefusal = null; crossingAsk = row.text("id")?.let { it to approve } },
            cancel = { crossingAsk = null; crossingRefusal = null }) { row, approve ->
            // The second press: the answer goes with the key of the crossing it was given on. Taken, the question closes over the
            // re-read row — a confirmed move reads as moved; refused, it stays open beside the door's own code and reason.
            val rowId = row.text("id")
            if (rowId != null && state.answeringCrossing == null) {
                state.answeringCrossing = rowId
                app.processScope.launch {
                    val refusal = try { api.decideCrossing(id, row, approve); null }
                        catch (cancel: CancellationException) { throw cancel }
                        catch (failure: Exception) { ProjectCrossings.refusal(failure) }
                        finally { state.answeringCrossing = null }
                    if (refusal != null) crossingRefusal = rowId to refusal
                    else {
                        crossingAsk = null; crossingRefusal = null
                        app.realtime.refreshDirectory()
                        if (state.attached) load(settled = true)
                    }
                }
            }
        }
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
            var reason by remember(current.blocker.text("id")) { mutableStateOf("") }
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
        ProjectDialog.Done -> ProjectDoneSheet(api, id, state, now, enabled, close = { dialog = null }) { refusal, body -> attempt(refusal, body) }
        // The jobs the landing row counts, read off the page's own integration read, which its polls keep current. Retry answers the
        // line read again, which the list redraws from at once; then the page reads everything again (iOS `retryIntegrationJob`).
        ProjectDialog.LandingJobs -> LandingJobsSheet(state.integration?.let { ProjectPage.landingJobLines(it, now, state.integrationReadAt, state.integrationReadFailed) }.orEmpty(),
            retry = { jobId ->
                attempt("") { api.retryJob(id, jobId)?.let { view -> state.integration = view; state.integrationReadAt = Instant.now(); state.integrationReadFailed = false } }
                    ?.let { "${ProjectPage.landingRetryFailed} — ${it.trimEnd('.')}." }
            }, openTask = { taskId -> dialog = null; openTask(taskId) }, close = { dialog = null })
        ProjectDialog.OpenItems -> OpenItemsSheet(state, doc, now, enabled, startOwn = { dialog = ProjectDialog.Start }, recordDone = { dialog = ProjectDialog.Done },
            // Review on the coordinator's request to start: into its conversation, onto the start card.
            reviewStart = { row -> dialog = null; openCoordinator(row.text("itemId")?.let { "start:$it" }) }, perform = perform,
            retry = { scope.launch { load(refreshGraph = false) } }, close = { dialog = null })
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
            if (ProjectDone.readyToClose(ProjectDoc.status(doc), state.openItems)) Chip(ProjectDone.readyToClose, TagTone.WARNING, Modifier.testTag("project-ready-to-close"))
            val count = ProjectDoc.taskCount(doc)
            Text("$count task${if (count == 1) "" else "s"}", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        if (ProjectDoc.status(doc) == "DONE") Text(ProjectDone.provenance(doc.text("doneBy"), doc.objects("acceptedGaps").size), Modifier.testTag("project-done-by"),
            style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
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

/** The toolbar's Open items (iOS `openItemsEntry`): the word, and every open item counted — amber while some are the owner's. */
@Composable
private fun OpenItemsEntry(summary: ProjectPage.OpenItemsSummary?, unread: Boolean, open: () -> Unit) {
    val warning = LocalOrbitColors.current.needsYou
    TextButton(onClick = open, modifier = Modifier.testTag("project-open-items").semantics {
        contentDescription = ProjectPage.openItemsHeading
        stateDescription = summary?.subtitle ?: if (unread) ProjectPage.openItemsCantLoad else ProjectPage.openItemsLoading
    }) {
        Text(ProjectPage.openItemsHeading, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurface)
        if (summary != null && summary.count > 0) {
            Spacer(Modifier.width(6.dp))
            Text("${summary.count}", Modifier.background(if (summary.needsYou > 0) warning else MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.15f),
                RoundedCornerShape(50)).padding(horizontal = 6.dp, vertical = 2.dp).testTag("project-open-items-count"),
                style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold,
                color = if (summary.needsYou > 0) Color.White else MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/** On the page, only what needs the owner (iOS `openItemsAttention`): a reminder that opens the sheet — or, with nothing to
 * remind of, the owner's own Start… on a project nobody asked to start, which stays discoverable. */
private fun LazyListScope.openItemsAttention(state: ProjectPageState, doc: JsonObject, enabled: Boolean, openSheet: () -> Unit, startOwn: () -> Unit) {
    val attention = ProjectPage.openItemsSummary(doc, state.openItems)?.attention
    if (attention != null) item(key = "open-items-attention") {
        val warning = LocalOrbitColors.current.needsYou
        Row(Modifier.fillMaxWidth().padding(top = 8.dp).background(warning.copy(alpha = 0.1f), RoundedCornerShape(10.dp))
            .clickable(role = Role.Button, onClick = openSheet).padding(horizontal = 12.dp, vertical = 12.dp).testTag("open-items-attention"),
            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(Modifier.size(16.dp).border(1.5.dp, warning, CircleShape), contentAlignment = Alignment.Center) {
                Text("!", style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold, color = warning)
            }
            Text(attention, Modifier.weight(1f), style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold, color = warning)
            Text("›", fontWeight = FontWeight.SemiBold, color = warning)
        }
    } else if (StartProjectCopy.pageRow(ProjectDoc.status(doc), ProjectDoc.started(doc), state.openItems) == StartProjectCopy.PageRow.Own) item(key = "start-own") {
        OwnRow(StartProjectCopy.rowOwn, StartProjectCopy.rowNotAsked, MaterialTheme.colorScheme.primary, enabled, "project-start-own", startOwn)
    }
}

/** Open items, over the page (iOS `openItemsSheet`): what needs the owner — the start, the close, the owner's items — then what is
 * with the coordinator. A first read that failed says so with Retry, rather than spinning or claiming there is nothing. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun OpenItemsSheet(state: ProjectPageState, doc: JsonObject, now: Instant, enabled: Boolean, startOwn: () -> Unit, recordDone: () -> Unit,
    reviewStart: (JsonObject) -> Unit, perform: (String, JsonObject) -> Unit, retry: () -> Unit, close: () -> Unit) {
    ModalBottomSheet(onDismissRequest = close, modifier = Modifier.testTag("project-open-items-sheet")) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(start = 20.dp, end = 12.dp, bottom = 24.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(ProjectPage.openItemsHeading, Modifier.weight(1f), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
                IconButton(onClick = close, modifier = Modifier.testTag("project-open-items-close")) {
                    Icon(painterResource(R.drawable.ic_close), ProjectPage.closeOpenItems, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            val items = state.openItems
            val summary = ProjectPage.openItemsSummary(doc, items)
            when {
                items != null && summary != null -> {
                    Text(summary.subtitle, Modifier.padding(end = 8.dp).testTag("project-open-items-subtitle"), style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                    val start = StartProjectCopy.pageRow(ProjectDoc.status(doc), ProjectDoc.started(doc), items)
                    val done = ProjectDone.pageRow(doc, items)
                    val needsYou = ProjectPage.needsYouRows(items)
                    val withCoordinator = items.objects("withCoordinator")
                    Column(Modifier.padding(end = 8.dp)) {
                        if (needsYou.isNotEmpty() || start != null || done != null) {
                            GroupLabel(ProjectPage.needsYouGroup)
                            when (start) {
                                is StartProjectCopy.PageRow.Asked -> AskedRow(StartProjectCopy.title, null,
                                    start.row.obj("startRequest")?.obj("settings")?.let(StartProjectCopy::requestSummary) ?: start.row.text("detailLine").orEmpty(),
                                    "${ProjectPage.who(start.row)} · ${ProjectPage.waitingLabel(start.row, now)}", enabled, "start-request") { reviewStart(start.row) }
                                StartProjectCopy.PageRow.Own -> OwnRow(StartProjectCopy.rowOwn, StartProjectCopy.rowNotAsked, MaterialTheme.colorScheme.primary, enabled,
                                    "project-start-own", startOwn)
                                null -> Unit
                            }
                            when (done) {
                                is ProjectDone.PageRow.Asked -> AskedRow(ProjectDone.heading, ProjectDone.readyToClose, ProjectDone.requestRowDetail(done.row),
                                    "${ProjectPage.who(done.row)} · ${ProjectPage.waitingLabel(done.row, now)}", enabled, "project-done-request", recordDone)
                                // Nobody asked: a grey hint, dot and title alike, counted with nothing that needs the owner.
                                ProjectDone.PageRow.Own -> OwnRow(ProjectDone.recordAsDoneRow, ProjectDone.notAskedYet, MaterialTheme.colorScheme.onSurfaceVariant, enabled,
                                    "project-done-own", recordDone)
                                null -> Unit
                            }
                            needsYou.forEach { row -> OpenItemRow(row, now, enabled, perform) { perform("REVIEW", row) } }
                        }
                        if (withCoordinator.isNotEmpty()) {
                            GroupLabel(ProjectPage.withCoordinatorGroup)
                            withCoordinator.forEach { row -> OpenItemRow(row, now, enabled, perform) { perform("OPEN_COORDINATOR", row) } }
                        }
                        if (summary.count == 0 && start == null && done == null)
                            Text(ProjectPage.nothingWaiting, Modifier.padding(top = 12.dp).testTag("project-open-items-empty"), color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                state.openItemsUnread -> Column(Modifier.fillMaxWidth().padding(vertical = 24.dp).testTag("project-open-items-failed"),
                    horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(ProjectPage.openItemsUnread, style = MaterialTheme.typography.titleMedium)
                    Button(onClick = retry) { Text("Retry") }
                }
                else -> CircularProgressIndicator(Modifier.align(Alignment.CenterHorizontally).padding(24.dp))
            }
        }
    }
}

@Composable
private fun GroupLabel(text: String) = Text(text.uppercase(), Modifier.padding(top = 14.dp, bottom = 2.dp), style = MaterialTheme.typography.labelSmall,
    fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurfaceVariant)

/** A request somebody asked the owner (iOS `startItem`'s asked row and `ProjectDoneRequestRow`): the amber dot over what it asks,
 * who asked and how long ago, and Review across the row — the whole row opens it too. */
@Composable
private fun AskedRow(title: String, flag: String?, detail: String, meta: String, enabled: Boolean, tag: String, review: () -> Unit) {
    val warning = LocalOrbitColors.current.needsYou
    Column(Modifier.fillMaxWidth().clickable(enabled = enabled, role = Role.Button, onClick = review).padding(vertical = 10.dp).testTag(tag),
        verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(Modifier.size(8.dp).background(warning, CircleShape))
            if (flag != null) Text(flag, style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold, color = warning)
            else Text(title, fontWeight = FontWeight.SemiBold)
        }
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            if (flag != null) Text(title, fontWeight = FontWeight.SemiBold)
            Text(detail, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(meta, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Button(onClick = review, enabled = enabled, modifier = Modifier.fillMaxWidth().testTag("$tag:action")) { Text(ProjectPage.actionLabel("REVIEW").orEmpty()) }
    }
    HorizontalDivider()
}

/** The owner's own press where nobody asked (Start…, Record as done…): a quiet row with a grey dot that opens the card over the page. */
@Composable
private fun OwnRow(title: String, note: String, ink: Color, enabled: Boolean, tag: String, press: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(enabled = enabled, role = Role.Button, onClick = press).padding(vertical = 10.dp).testTag(tag),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        Box(Modifier.size(8.dp).background(MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.45f), CircleShape))
        Column(Modifier.weight(1f)) {
            Text(title, color = ink, fontWeight = FontWeight.SemiBold)
            Text(note, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Text("›", color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** One open item (iOS `openItem`): whose it is, the item's own words, how long it has waited, and its first press across the row;
 * the whole row opens the card it is answered on, in the coordinator conversation. */
@Composable
private fun OpenItemRow(row: JsonObject, now: Instant, enabled: Boolean, perform: (String, JsonObject) -> Unit, tap: () -> Unit) {
    val owner = row.text("assignee") != "COORDINATOR"
    val action = ProjectPage.primaryAction(row)
    val tag = "open-item:${row.text("itemId")}"
    Column(Modifier.fillMaxWidth().clickable(enabled = enabled, role = Role.Button, onClick = tap).padding(vertical = 10.dp).testTag(tag),
        verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Box(Modifier.size(8.dp).background(if (owner) LocalOrbitColors.current.needsYou else MaterialTheme.colorScheme.primary, CircleShape))
            Text(ProjectPage.who(row), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(row.text("title").orEmpty(), fontWeight = FontWeight.SemiBold)
            row.text("detailLine")?.takeIf { it.isNotEmpty() }?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
        Text(ProjectPage.waitingLabel(row, now), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        action?.let { verb -> ProjectPage.actionLabel(verb)?.let { label ->
            Button(onClick = { perform(verb, row) }, enabled = enabled, modifier = Modifier.fillMaxWidth().testTag("$tag:action")) { Text(label, textAlign = TextAlign.Center) }
        } }
    }
    HorizontalDivider()
}

private fun LazyListScope.overviewSection(state: ProjectPageState, doc: JsonObject, now: Instant, openTask: (String) -> Unit, openJobs: () -> Unit) {
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
            // On a server that lists its jobs, a press on the row opens them; an older server's row stays a row.
            state.integration?.let { view -> ProjectPage.landingLine(view, now, state.integrationReadAt, state.integrationReadFailed)?.let {
                LandingRow(it, if (ProjectPage.inFlightJobs(view) != null) openJobs else null) } }
            cells.chunked(2).forEach { pair -> Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                pair.forEach { cell -> Column(Modifier.weight(1f).testTag("overview:${cell.key}")) {
                    // The lane's shape carries its colour; the label stays the page's ink (`overviewCell`).
                    Text(buildAnnotatedString {
                        withStyle(SpanStyle(color = if (cell.key == "ready" || cell.key == "integrating") MaterialTheme.colorScheme.onSurfaceVariant
                            else glyphColor(cell.glyph))) { append(glyphText(cell.glyph)) }
                        append(" ${cell.label}")
                    }, style = MaterialTheme.typography.labelMedium)
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

/** The landing in flight (ProjectLandingRow.swift): what the platform is doing while the counts stand still — and, on a server that
 * lists its jobs, a press that opens them. */
@Composable
private fun LandingRow(line: LandingLine, openJobs: (() -> Unit)?) {
    Row(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(8.dp))
        .then(if (openJobs != null) Modifier.clickable(role = Role.Button, onClick = openJobs) else Modifier).padding(10.dp).testTag("landing-row"),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        LandingLineView(line, Modifier.weight(1f))
        if (openJobs != null) Text("›", fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** One landing line: the ring (spinning while it runs), what is landing and how far it got, and its clock. A job the server judged
 * timed out is in the warning ink with a triangle where the ring was: nothing moves for a runner that stopped reporting. */
@Composable
private fun LandingLineView(line: LandingLine, modifier: Modifier = Modifier) {
    val warning = LocalOrbitColors.current.needsYou
    Row(modifier, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        when {
            line.timedOut -> Icon(painterResource(R.drawable.ic_warning), null, Modifier.size(16.dp).testTag("landing-timed-out"), tint = warning)
            line.running -> CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
            else -> Text("◌", color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Column(Modifier.weight(1f)) {
            Text(listOfNotNull(line.word, line.what).joinToString(" · "), fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis,
                color = if (line.timedOut) warning else if (line.running) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface)
            Text(listOfNotNull(line.state, line.updated).joinToString(" · "), style = MaterialTheme.typography.labelMedium,
                color = if (line.timedOut) warning else if (line.running) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Column(horizontalAlignment = Alignment.End) {
            Text(line.clockLabel, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(line.clock, style = MaterialTheme.typography.labelLarge, color = if (line.timedOut) warning else Color.Unspecified)
        }
    }
}

/** "2 jobs in flight" — what pressing the landing row opens (iOS `ProjectLandingJobsSheet`): every job the row counts, one row each,
 * drawn as the landing row itself with its task's title. A task's row opens that task; a job the server says can be retried offers
 * Retry, and a Retry that did not go through says why under its row. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun LandingJobsSheet(lines: List<LandingJobLine>, retry: suspend (String) -> String?, openTask: (String) -> Unit, close: () -> Unit) {
    // The jobs a Retry is on its way for take no second press; why one did not go through stays under its row.
    var retrying by remember { mutableStateOf<Set<String>>(emptySet()) }
    var failures by remember { mutableStateOf<Map<String, String>>(emptyMap()) }
    val scope = rememberCoroutineScope()
    ModalBottomSheet(onDismissRequest = close, modifier = Modifier.testTag("landing-jobs-sheet")) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(start = 16.dp, end = 16.dp, bottom = 24.dp)) {
            Box(Modifier.fillMaxWidth()) {
                Text(ProjectPage.landingJobsTitle(lines.size), Modifier.align(Alignment.Center).semantics { heading() }.testTag("landing-jobs-title"),
                    style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
                IconButton(onClick = close, modifier = Modifier.align(Alignment.CenterEnd).testTag("landing-jobs-close")) {
                    Icon(painterResource(R.drawable.ic_close), "Close", tint = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            Column(Modifier.padding(top = 8.dp).fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(12.dp))) {
                lines.forEachIndexed { index, row ->
                    if (index > 0) HorizontalDivider(Modifier.padding(start = 38.dp))
                    Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp).testTag("landing-job:${row.jobId}"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        // A job with no task keeps the chevron's room, so every row's clock lines up.
                        Row(Modifier.fillMaxWidth().then(if (row.taskId != null) Modifier.clickable(role = Role.Button) { openTask(row.taskId) } else Modifier),
                            verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                LandingLineView(row.line)
                                row.detail?.let { Text(it, Modifier.testTag("landing-job:${row.jobId}:detail"), style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant) }
                            }
                            Text("›", Modifier.alpha(if (row.taskId != null) 1f else 0f).clearAndSetSemantics { }, fontWeight = FontWeight.SemiBold,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        if (row.retryable) OutlinedButton(onClick = {
                            if (row.jobId !in retrying) {
                                retrying = retrying + row.jobId; failures = failures - row.jobId
                                scope.launch {
                                    try { retry(row.jobId)?.let { failures = failures + (row.jobId to it) } } finally { retrying = retrying - row.jobId }
                                }
                            }
                        }, enabled = row.jobId !in retrying, modifier = Modifier.testTag("landing-job:${row.jobId}:retry")) { Text(ProjectPage.landingRetry) }
                        failures[row.jobId]?.let { Text(it, Modifier.testTag("landing-job:${row.jobId}:failure"), style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.error) }
                    }
                }
            }
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
                item.text("runState") == "READY" -> RunPress(if (item.text("taskId") in state.starting) ProjectPage.runPressStarting else ProjectPage.runPress,
                    enabled, "queue:${item.text("taskId")}:run", "Run ${item.text("title").orEmpty()}") { run(item) }
                item.text("runState") == "PAUSED" && item.obj("pausedList") != null -> OutlinedButton(onClick = { resume(item) }, enabled = enabled) { Text(ProjectPage.resumeListPress) }
                item.text("runState") in setOf("RUNNING", "QUEUED") && item.text("sessionId") != null -> TextButton(onClick = {
                    item.text("sessionId")?.let { open(OrbitRoute(Destination.SESSION, it)) } }) { Text(ProjectPage.openRunSession) }
                else -> Chip(ProjectPage.queueRowTag(item.text("runState")), TagTone.NEUTRAL)
            }
        }
    }
    if (queue.objects("items").isNotEmpty()) item(key = "queue-help") { Text(ProjectPage.queueHelp(queue), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
}

/** The run queue's Run (iOS 6f2a10f9f): the play mark and the word in the tint on a light tint of it, a 48dp press however
 * small the label, and half faded while it cannot be pressed. */
@Composable
internal fun RunPress(label: String, enabled: Boolean, tag: String, description: String, run: () -> Unit) {
    val tint = MaterialTheme.colorScheme.primary
    Box(Modifier.heightIn(min = 48.dp).alpha(if (enabled) 1f else 0.5f).clickable(enabled = enabled, role = Role.Button, onClick = run)
        .testTag(tag).semantics { contentDescription = description }, contentAlignment = Alignment.Center) {
        Row(Modifier.widthIn(min = 72.dp).heightIn(min = 34.dp).background(tint.copy(alpha = 0.08f), RoundedCornerShape(9.dp))
            .padding(horizontal = 12.dp, vertical = 8.dp), verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterHorizontally)) {
            Icon(painterResource(R.drawable.ic_play), null, Modifier.size(12.dp).testTag("$tag:play"), tint = tint)
            Text(label, style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold, color = tint, maxLines = 1)
        }
    }
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

/** Work asked across this project's line, in either direction — the account owner's to answer, and nobody else's (iOS
 * `crossingsSection`, web's `ProjectCrossingsCard.tsx`): drawn once the project is an end of a crossing, or when the read failed
 * with nothing to show. */
private fun LazyListScope.crossingsSection(state: ProjectPageState, connected: Boolean, asking: Pair<String, Boolean>?,
    refused: Pair<String, ProjectCrossings.Refusal>?, ask: (JsonObject, Boolean) -> Unit, cancel: () -> Unit, answer: (JsonObject, Boolean) -> Unit) {
    val rows = state.crossings
    if (!rows.isNullOrEmpty()) {
        item(key = "crossings-head") { SectionHead(ProjectCrossings.title, ProjectCrossings.waiting(ProjectCrossings.waitingCount(rows)), Modifier.testTag("crossings-head")) }
        items(ProjectCrossings.ordered(rows), key = { "crossing:${it.text("id")}" }) { row ->
            val id = row.text("id")
            val mine = asking?.first == id
            CrossingRow(row, if (mine) asking?.second else null, busy = state.answeringCrossing == id,
                locked = state.answeringCrossing != null && state.answeringCrossing != id, connected = connected,
                refusal = if (mine && refused?.first == id) refused?.second else null, ask = { ask(row, it) }, cancel = cancel, answer = { answer(row, it) })
        }
    } else if (state.crossingsUnread) item(key = "crossings-unread") {
        SectionHead(ProjectCrossings.title)
        Text("⚠ ${ProjectCrossings.unreadable}", Modifier.testTag("crossings-unread"), style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** One crossing (iOS `ProjectCrossingRow`, web's `CrossingRow`): where it stands — the server's state beside what it is called, and
 * the kind — then what it is about, both ends by title and id, what follows from the state, a move's criteria and the reason given.
 * A question offers two presses; the second names the subject and both ends, says what the answer does, shows the crossing key it
 * echoes, and sends it. A refusal stays on its row with the door's own code and reason, the second press still open. */
@Composable
private fun CrossingRow(row: JsonObject, confirming: Boolean?, busy: Boolean, locked: Boolean, connected: Boolean, refusal: ProjectCrossings.Refusal?,
    ask: (Boolean) -> Unit, cancel: () -> Unit, answer: (Boolean) -> Unit) {
    val id = row.text("id")
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    val mono = SpanStyle(fontFamily = FontFamily.Monospace, color = secondary)
    Column(Modifier.fillMaxWidth().padding(vertical = 8.dp).testTag("crossing:$id"), verticalArrangement = Arrangement.spacedBy(5.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            CodeTag(row.text("state").orEmpty())
            Text(ProjectCrossings.label(row.text("state").orEmpty()), style = MaterialTheme.typography.labelLarge, fontWeight = FontWeight.SemiBold)
            CodeTag(row.text("kind").orEmpty())
        }
        if (ProjectCrossings.isMove(row)) Text(buildAnnotatedString {
            withStyle(SpanStyle(color = secondary)) { append("${ProjectCrossings.moveSubjectLabel}: ") }
            withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(ProjectCrossings.subjectTitle(row)) }
            ProjectCrossings.subjectId(row)?.let { withStyle(mono) { append(" $it") } }
        }, Modifier.testTag("crossing:$id:subject"))
        else Text(row.text("title").orEmpty())
        Text(buildAnnotatedString {
            fun end(project: JsonObject?, code: String) {
                withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { append(project?.text("title") ?: ProjectCrossings.unnamedProject) }
                withStyle(mono) { append(" $code") }
                project?.text("status")?.let { withStyle(SpanStyle(color = secondary)) { append(" · $it") } }
            }
            end(row.obj("fromProject"), ProjectCrossings.fromId(row))
            withStyle(SpanStyle(color = secondary)) { append(ProjectCrossings.arrow) }
            end(row.obj("toProject"), ProjectCrossings.toId(row))
        }, style = MaterialTheme.typography.labelMedium)
        Text(ProjectCrossings.meaning(row), Modifier.testTag("crossing:$id:meaning"), style = MaterialTheme.typography.labelMedium, color = secondary)
        if (ProjectCrossings.isMove(row)) {
            row.obj("requestedCriterion")?.let { CrossingCriterion(ProjectCrossings.moveRequestedCriterionLabel, it.text("text") ?: ProjectCrossings.moveCriterionGone, it.text("key").orEmpty()) }
            row.obj("withdrawnCriterion")?.let { CrossingCriterion(ProjectCrossings.moveWithdrawnCriterionLabel, it.text("text").orEmpty(), it.text("key").orEmpty(),
                ProjectCrossings.moveWithdrawnCriterionNote) }
        }
        row.text("reason")?.let { Text(ProjectCrossings.reasonGiven(it), style = MaterialTheme.typography.labelMedium, color = secondary) }
        refusal?.let { refused ->
            Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.error.copy(alpha = 0.08f), RoundedCornerShape(8.dp)).padding(8.dp)
                .testTag("crossing:$id:refusal"), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text("⚠ ${ProjectCrossings.notRecorded}", style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.error)
                Text(buildAnnotatedString {
                    refused.code?.let { withStyle(SpanStyle(fontFamily = FontFamily.Monospace)) { append("$it ") } }
                    append(refused.message)
                }, style = MaterialTheme.typography.labelMedium)
            }
        }
        if (ProjectCrossings.isAnswerable(row.text("state"))) {
            if (confirming != null) {
                val prompt = ProjectCrossings.prompt(row, confirming)
                val tint = if (confirming) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error
                Column(Modifier.fillMaxWidth().background(tint.copy(alpha = 0.07f), RoundedCornerShape(8.dp)).padding(10.dp).testTag("crossing:$id:confirm"),
                    verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(ProjectCrossings.question(prompt), fontWeight = FontWeight.SemiBold)
                    Text(prompt.consequence, style = MaterialTheme.typography.labelMedium, color = secondary)
                    Text(buildAnnotatedString {
                        withStyle(SpanStyle(color = secondary)) { append("${ProjectCrossings.crossingKeyLabel} ") }
                        withStyle(SpanStyle(fontFamily = FontFamily.Monospace)) { append(ProjectCrossings.shortKey(row.text("crossingKey").orEmpty())) }
                    }, style = MaterialTheme.typography.labelMedium)
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Button(onClick = { answer(confirming) }, enabled = !busy && !locked && connected, modifier = Modifier.testTag("crossing:$id:answer"),
                            colors = ButtonDefaults.buttonColors(containerColor = tint)) {
                            if (busy) { CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary); Spacer(Modifier.width(6.dp)) }
                            Text(ProjectCrossings.confirmLabel(prompt))
                        }
                        OutlinedButton(onClick = cancel, enabled = !busy, modifier = Modifier.testTag("crossing:$id:cancel")) { Text(ProjectCrossings.cancel) }
                    }
                }
            } else Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(onClick = { ask(true) }, enabled = !locked, modifier = Modifier.testTag("crossing:$id:approve")) { Text(ProjectCrossings.approveAsk) }
                OutlinedButton(onClick = { ask(false) }, enabled = !locked, modifier = Modifier.testTag("crossing:$id:refuse")) {
                    Text(ProjectCrossings.refuseAsk, color = if (locked) Color.Unspecified else MaterialTheme.colorScheme.error) }
            }
        }
    }
    HorizontalDivider()
}

/** The server's own value as a chip: the state's word comes beside it, never instead of it. */
@Composable
private fun CodeTag(code: String) = Text(code, Modifier.background(MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.12f), RoundedCornerShape(5.dp))
    .padding(horizontal = 6.dp, vertical = 1.dp), style = MaterialTheme.typography.labelSmall, fontFamily = FontFamily.Monospace, fontWeight = FontWeight.SemiBold,
    color = MaterialTheme.colorScheme.onSurfaceVariant)

/** A move's criterion: what the task would count towards over there, or what it counts towards here now. */
@Composable
private fun CrossingCriterion(label: String, text: String, key: String, note: String? = null) {
    val secondary = MaterialTheme.colorScheme.onSurfaceVariant
    Text(buildAnnotatedString {
        withStyle(SpanStyle(color = secondary)) { append("$label: ") }
        append(text)
        withStyle(SpanStyle(fontFamily = FontFamily.Monospace, color = secondary)) { append(" $key") }
        note?.let { withStyle(SpanStyle(color = secondary)) { append(" $it") } }
    }, style = MaterialTheme.typography.labelMedium)
}
