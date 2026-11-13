@file:OptIn(androidx.compose.foundation.layout.ExperimentalLayoutApi::class)

package io.orbitd.android.tasks

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
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
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.draw.clipToBounds
import io.orbitd.android.OrbitApplication
import io.orbitd.android.attachments.AttachmentActions
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.cards.*
import io.orbitd.android.core.net.ApiError
import io.orbitd.android.core.net.ApiRequest
import io.orbitd.android.directory.orderedWorkspaceRows
import io.orbitd.android.composer.ComposerCatalog
import io.orbitd.android.composer.CredentialKind
import io.orbitd.android.composer.EngineCopy
import io.orbitd.android.composer.ProviderEngines
import io.orbitd.android.management.LocalSmartSelection
import io.orbitd.android.management.RunnerPage
import io.orbitd.android.navigation.*
import io.orbitd.android.projects.TaskDependencyGraphView
import io.orbitd.android.taskprojects.*
import io.orbitd.android.text.*
import io.orbitd.android.ui.LocalOrbitColors
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*
import java.util.UUID

/** Everything the page read for one task. A re-read replaces it in place; a failed one keeps it. */
/** Comment drafts are the app's, not the route's saved state: a comment the server took clears its draft even when the
 * page was left while it went out, so reopening the task never offers the sent text again; one the server refused stays
 * to be sent again (iOS clears the field only on success). Keyed by account and task. */
internal object TaskCommentDrafts {
    private val drafts = mutableStateMapOf<String, String>()
    operator fun get(key: String): String = drafts[key].orEmpty()
    operator fun set(key: String, text: String) { if (text.isEmpty()) drafts.remove(key) else drafts[key] = text }
    fun sent(key: String, body: String) { if (drafts[key]?.trim() == body) drafts.remove(key) }
}

private class TaskDetailData {
    var task by mutableStateOf<JsonObject?>(null)
    var missing by mutableStateOf(false)
    var loadError by mutableStateOf<String?>(null)
    var error by mutableStateOf<String?>(null)
    var conflict by mutableStateOf<TaskRunHandoff.Conflict?>(null)
    var notice by mutableStateOf<String?>(null)
    var owner by mutableStateOf<JsonObject?>(null)
    var attribution by mutableStateOf<JsonObject?>(null)
    var attributionFailed by mutableStateOf(false)
    /** The task's completion evidence, oldest first: what Delivered and the Activity read. Kept as it was when a read fails. */
    var evidence by mutableStateOf<List<JsonObject>>(emptyList())
    var graph by mutableStateOf<JsonObject?>(null)
    var watches by mutableStateOf<List<JsonObject>?>(null)
    var watchesFailed by mutableStateOf(false)
    var lists by mutableStateOf<List<JsonObject>>(emptyList())
    var share by mutableStateOf<JsonObject?>(null)
    var runner by mutableStateOf<JsonObject?>(null)
    /** Every runner of the account: whether Cursor CLI is offered as a pin at all (ProviderEngines.androidShowsEngine). */
    var runners by mutableStateOf<List<JsonObject>>(emptyList())
    var providers by mutableStateOf<List<JsonObject>>(emptyList())
    var busy by mutableStateOf(false)
    /** A refusal of what an open sheet sent, said on the sheet: the page's banner is behind it. */
    var sheetError by mutableStateOf<String?>(null)
    /** Whether the page is still shown: a write that outlives it finishes, but reads nothing back. */
    var attached = true
}

private sealed interface DetailConfirm {
    data object Delete : DetailConfirm
    data object Reopen : DetailConfirm
    data class RemoveInput(val input: JsonObject) : DetailConfirm
    data class RemovePrerequisite(val row: DependencyRow) : DetailConfirm
}

@Composable
internal fun TaskDetail(app: OrbitApplication, handle: SessionHandle, id: String, revision: Long, open: (OrbitRoute) -> Unit, back: () -> Unit) {
    val api = remember(handle) { TaskApi(app.session, handle) { app.canWrite(handle) } }
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboardManager.current
    val live by app.realtime.state.collectAsState()
    val auth by app.session.state.collectAsState()
    val connected = writable(live, handle, (auth as? AuthState.SignedIn)?.handle)
    val workspaces = live.directory?.workspaces.orEmpty()
    val data = remember(handle, id) { TaskDetailData() }
    DisposableEffect(data) { data.attached = true; onDispose { data.attached = false } }
    var sheet by rememberSaveable(id) { mutableStateOf<String?>(null) }
    var confirm by remember { mutableStateOf<DetailConfirm?>(null) }
    val draft = "${handle.account.server}|${handle.account.userId}|$id"
    val comment = TaskCommentDrafts[draft]
    var dependencyView by rememberSaveable(id) { mutableStateOf<String?>(null) }
    var planOpen by rememberSaveable(id) { mutableStateOf(false) }
    var composeToRun by rememberSaveable(id) { mutableStateOf(true) }
    var targetMenu by remember { mutableStateOf(false) }
    var menu by remember { mutableStateOf(false) }
    var viewing by remember { mutableStateOf<JsonObject?>(null) }
    val resources = LocalReaderResources.current ?: remember(handle) { ReaderResources(app.session, handle) }
    val link = rememberReaderLinkHandler(resources, open)

    /** The detail and every read beside it; the side reads are optional and keep their last answer. */
    suspend fun load() {
        try {
            val task = api.detail(id)
            data.task = task; data.missing = false; data.loadError = null
            coroutineScope {
                val owner = async { runCatching { api.ownerConfirmation(id) }.getOrNull() }
                val attribution = async { runCatching { api.attribution(id) } }
                val graph = async { runCatching { api.dependencyGraph(id) }.getOrNull() }
                val evidence = async { runCatching { api.evidence(id) }.getOrNull() }
                val watches = async { runCatching { api.watches() } }
                val lists = async { runCatching { api.lists() }.getOrNull() }
                val share = async { runCatching { api.share(id) }.getOrNull() }
                val runnerId = workspaces.firstOrNull { ObjectId.same(it.text("id"), task.obj("assignee")?.text("id")) }?.text("runnerId")
                val runner = async { runnerId?.let { runCatching { api.read(listOf("runners", it)) as? JsonObject }.getOrNull() } }
                // The keys with the engines each runs on, and the account pools read as providers: what a pin can name.
                fun rows(vararg path: String) = async { runCatching { (api.read(path.toList()) as? JsonArray).orEmpty().filterIsInstance<JsonObject>() }.getOrNull() }
                val providers = rows("providers")
                val runners = rows("runners")
                val pools = rows("providers", "pools")
                val sharedPools = rows("providers", "shared-pools")
                data.owner = owner.await()
                attribution.await().onSuccess { data.attribution = it; data.attributionFailed = false }.onFailure { if (data.attribution == null) data.attributionFailed = true }
                graph.await()?.let { data.graph = it }
                evidence.await()?.let { data.evidence = it }
                watches.await().onSuccess { data.watches = it; data.watchesFailed = false }.onFailure { data.watchesFailed = true }
                lists.await()?.let { data.lists = it }
                share.await()?.let { data.share = it }
                runner.await()?.let { data.runner = it }
                runners.await()?.let { data.runners = it }
                providers.await()?.let { keys ->
                    data.providers = (keys + pools.await().orEmpty().map { ProviderEngines.poolRow(it, ProviderEngines.CLAUDE) } +
                        sharedPools.await().orEmpty().map { ProviderEngines.poolRow(it, ProviderEngines.CODEX) }).distinctBy { it.text("slug") }
                }
            }
        } catch (cancel: CancellationException) { throw cancel }
        catch (failure: Exception) {
            if (failure is ApiError && failure.status == 404) { data.task = null; data.missing = true }
            else {
                // A read this account may no longer make withdraws what it showed, as A04 withdraws a session.
                if (failure is ApiError && failure.status == 403) data.task = null
                data.loadError = taskError(failure)
            }
        }
    }
    LaunchedEffect(handle, id) { load() }
    // Live events are coalesced: one read two seconds after the first of a burst, never cancelled by the next.
    val nudge = remember(handle, id) { RefreshNudge(scope) { if (data.task != null) load() } }
    LaunchedEffect(handle, id, revision) { if (revision > 0) nudge.nudge() }
    val busyRun = data.task?.let(TaskListLogic::isBusy) == true
    // While a run of it is going, the page follows it: that is when its owner may be asked something.
    LaunchedEffect(handle, id, busyRun) { while (busyRun) { delay(4000); load() } }
    // §2.7a's cadence, while the landing is live: 4 s for one that runs, 15 s for one that waits.
    // A busy run already re-reads every 4 s, which covers a running landing too.
    val landingEvery = if (busyRun) null else TaskLandingLogic.refetchInterval(TaskIntegrationView.of(data.task))
    LaunchedEffect(handle, id, landingEvery) { while (landingEvery != null) { delay(landingEvery); load() } }
    LaunchedEffect(data.notice) { if (data.notice != null) { delay(3000); data.notice = null } }

    /** A write belongs to the app, not to this page (iOS's model-owned Task): leaving does not cancel it,
     * so a Run's resends and a comment still go out. A sheet that sent it closes only once it is taken, and its
     * answer is that sheet's alone — shown under it, or on the page's banner once it (or the page) is gone.
     * The page is busy until it has read the write back, where iOS's `mutate` ends `mutating`: a Run pressed before that read
     * lands goes out over the task as it was before its run started, under a new trigger, and the server refuses it as already
     * running (A15 F-22's kind). */
    fun mutate(fromSheet: String? = null, done: () -> Unit = {}, operation: suspend () -> Unit) {
        if (data.busy) return
        data.busy = true; data.error = null; data.conflict = null; data.sheetError = null
        app.processScope.launch {
            fun ownSheet() = fromSheet != null && data.attached && sheet == fromSheet
            try { operation(); if (fromSheet == null || ownSheet()) done() }
            catch (cancel: CancellationException) { throw cancel }
            catch (failure: Exception) {
                val conflict = TaskRunHandoff.readConflict(failure)
                when {
                    conflict != null -> data.conflict = conflict
                    ownSheet() -> data.sheetError = taskError(failure)
                    else -> data.error = taskError(failure)
                }
            } finally {
                try {
                    app.realtime.refreshDirectory()
                    if (data.attached) load()
                } finally { data.busy = false }
            }
        }
    }
    fun revisionOf(task: JsonObject) = "${task.text("id")}:${task.text("updatedAt")}"
    fun patch(fields: JsonObject, saved: String? = null, fromSheet: String? = null, done: () -> Unit = {}) { val task = data.task ?: return
        mutate(fromSheet, done) { api.update(id, fields, revisionOf(task) + ":" + fields); saved?.let { data.notice = it } } }
    /** The engine and credential this task's runs use (board 6), as TaskApi.pin writes them. */
    fun pin(change: TaskPin) { val task = data.task ?: return
        mutate { api.pin(id, change, revisionOf(task) + ":" + change.request()) } }
    fun closeSheet() { sheet = null; data.sheetError = null }

    val task = data.task
    if (task == null) {
        Box(Modifier.fillMaxSize().testTag("task-detail"), contentAlignment = Alignment.Center) {
            when {
                data.missing -> Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text("This task is no longer available.", style = MaterialTheme.typography.titleMedium)
                    TextButton(onClick = back) { Text("Back") }
                }
                data.loadError != null -> Column(Modifier.padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(TaskDetailCopy.loadFailed, style = MaterialTheme.typography.titleMedium)
                    Text(data.loadError.orEmpty(), style = MaterialTheme.typography.bodySmall)
                    Button(onClick = { scope.launch { load() } }) { Text("Retry") }
                }
                else -> CircularProgressIndicator()
            }
        }
        return
    }
    val enabled = connected && !data.busy
    val assigneeWorkspace = workspaces.firstOrNull { ObjectId.same(it.text("id"), task.obj("assignee")?.text("id")) }
    val assigneeHasRunner = assigneeWorkspace?.text("runnerId") != null || task.obj("assignee")?.obj("runner")?.text("id") != null
    val canStart = TaskListLogic.canStart(task, assigneeHasRunner)
    val gate = TaskJudgment.isGateRow(task)
    val status = task.text("status")
    val row = TaskDetailLogic.actionRow(OwnerConfirmations.panelAction(data.owner?.takeIf { ObjectId.same(it.text("taskId"), id) }, task),
        status, gate, TaskRunHandoff.entry(task))
    val graph = TaskDetailLogic.dependencyGraph(task, data.graph)
    val webUrl = "${handle.account.server.trimEnd('/')}/tasks/${task.text("id") ?: id}"
    val smartSelection = LocalSmartSelection.current
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    fun runTask() { val trigger = UUID.randomUUID().toString(); mutate { api.execute(id, trigger, revisionOf(task)) } }
    // To the run while one is going: the comment mentions the run's workspace, and the mention delivery puts it into that
    // workspace's live run on this task (board 04 ⑤).
    val recipient = TaskDetailLogic.runRecipient(task)
    val toRun = recipient != null && composeToRun
    val (followers, endedWatches) = TaskDetailLogic.followers(id, data.watches.orEmpty())

    Column(Modifier.fillMaxSize()) {
        LazyColumn(Modifier.weight(1f).testTag("task-detail"), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            item(key = "head") {
                Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    Row(verticalAlignment = Alignment.Top) {
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                            task.obj("project")?.let { project ->
                                Text("▦ ${project.text("title").orEmpty()}" + if (project.text("status") == "CANCELLED") "  Cancelled" else "",
                                    Modifier.clickable(role = Role.Button) { project.text("id")?.let { open(OrbitRoute(Destination.PROJECT, it)) } }.testTag("task-project"),
                                    color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.labelMedium)
                                if (project.text("status") == "CANCELLED") Text(TaskDetailCopy.projectCancelledNote, style = MaterialTheme.typography.bodySmall,
                                    color = muted)
                            }
                            SelectionContainer { Text(task.text("title") ?: "Untitled task", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold) }
                        }
                        Box {
                            TextButton(onClick = { menu = true }, modifier = Modifier.testTag("task-menu").semantics { contentDescription = "Task actions" }) { Text("⋯", style = MaterialTheme.typography.titleLarge) }
                            DropdownMenu(menu, { menu = false }) {
                                // The presses a stopped task's header no longer draws, and the two that used to be blocks of their own (board 05).
                                if (TaskReopen.isOffered(task)) DropdownMenuItem(text = { Text(TaskReopenCopy.actionLabel) }, enabled = enabled,
                                    modifier = Modifier.testTag("task-reopen"), onClick = { menu = false; confirm = DetailConfirm.Reopen })
                                if ((status == "DONE" || status == "CANCELLED") && !gate) DropdownMenuItem(text = { Text(TaskDetailCopy.runAgain) },
                                    enabled = enabled && canStart, modifier = Modifier.testTag("task-run-again"), onClick = { menu = false; runTask() })
                                DropdownMenuItem(text = { Text(TaskDetailCopy.followTask) }, enabled = enabled, modifier = Modifier.testTag("task-follow"),
                                    onClick = { menu = false; sheet = "follow" })
                                if (!TaskDetailLogic.hasDependencies(task)) DropdownMenuItem(text = { Text(TaskDetailCopy.addPrerequisite) }, enabled = enabled,
                                    modifier = Modifier.testTag("task-add-prerequisite"), onClick = { menu = false; sheet = "dependency" })
                                HorizontalDivider()
                                DropdownMenuItem(text = { Text(SharePanelCopy.copyLink) }, onClick = { menu = false; clipboard.setText(AnnotatedString(webUrl)); data.notice = SharePanelCopy.linkCopied })
                                DropdownMenuItem(text = { Column { Text(SharePanelCopy.share); SharePanel.menuStatus(data.share)?.let { Text(it, style = MaterialTheme.typography.bodySmall) } } },
                                    enabled = enabled, onClick = { menu = false; sheet = "share" })
                                DropdownMenuItem(text = { Text(SharePanelCopy.copyAsMarkdown) }, onClick = {
                                    menu = false
                                    clipboard.setText(AnnotatedString(TaskMarkdown.task(task, webUrl) { iso -> TaskTime.local(iso) ?: "—" }))
                                    data.notice = SharePanelCopy.markdownCopied
                                })
                                // Setting the status by hand starts nothing and confirms nothing, so it is held here rather than beside the
                                // presses under the title.
                                if (status != "DONE") {
                                    HorizontalDivider()
                                    DropdownMenuItem(text = { Text(TaskDetailCopy.markDone) }, enabled = enabled, modifier = Modifier.testTag("task-mark-done"),
                                        onClick = { menu = false; patch(buildJsonObject { put("status", "DONE") }) })
                                }
                                HorizontalDivider()
                                DropdownMenuItem(text = { Text(TaskDetailCopy.deleteTask, color = MaterialTheme.colorScheme.error) }, enabled = enabled,
                                    onClick = { menu = false; confirm = DetailConfirm.Delete })
                            }
                        }
                    }
                    // The status line: one status (with how long a run has been going), who has the task, what its newest run is on, and
                    // what its runs have cost. When it was filed is on the Activity timeline. Wraps rather than squeezing a word a line.
                    FlowRow(Modifier.testTag("task-status-line"), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp),
                        itemVerticalAlignment = Alignment.CenterVertically) {
                        TaskStatusPill(TaskDetailLogic.headPill(task))
                        task.obj("assignee")?.let { assignee -> Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            Avatar(assignee.text("name")); Text(assignee.text("name") ?: TaskListCopy.unassigned, maxLines = 1, style = MaterialTheme.typography.bodySmall) } }
                        task.objects("sessions").firstNotNullOfOrNull { it.text("model")?.takeIf(String::isNotEmpty) }?.let {
                            Text("· ${modelName(it, task, data)}", style = MaterialTheme.typography.bodySmall, color = muted, maxLines = 1) }
                        TaskDetailLogic.totalCost(task)?.let { Text("· $it", style = MaterialTheme.typography.bodySmall, color = muted, maxLines = 1) }
                    }
                    TaskJudgment.chip(task)?.let { chip ->
                        Text("${if (chip.isGate) "◈" else "✓"} ${chip.text}", Modifier.testTag("task-judgment").background(
                            if (chip.isGate) LocalOrbitColors.current.needsYou.copy(alpha = 0.1f) else MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(50))
                            .padding(horizontal = 8.dp, vertical = 3.dp), style = MaterialTheme.typography.labelMedium,
                            color = if (chip.isGate) LocalOrbitColors.current.needsYou else muted)
                    }
                    if (!connected) OfflineNote()
                    data.loadError?.let { TaskErrorBanner(it, retry = { scope.launch { load() } }) { data.loadError = null } }
                    data.error?.let { TaskErrorBanner(it) { data.error = null } }
                    data.notice?.let { Text(it, Modifier.testTag("task-notice"), style = MaterialTheme.typography.bodySmall, color = LocalOrbitColors.current.success) }
                    data.conflict?.let { conflict -> TaskRunConflictCard(conflict, { open(OrbitRoute(Destination.SESSION, it)) },
                        conflict.taskId?.let { { patch(buildJsonObject { put("provider", JsonNull); put("model", JsonNull) }) } }) { data.conflict = null } }
                    ActionRow(row, canStart, enabled, task, assigneeHasRunner, open, run = ::runTask,
                        confirmDone = { mutate { api.confirmOwner(id, revisionOf(task)) } })
                }
            }
            // The check that settles this row, under the row it checks.
            if (gate || task.obj("verifier") != null) item(key = "verifier") {
                TaskSectionHeader(TaskJudgmentCopy.verifierCardHeading)
                val verifier = task.obj("verifier")
                if (verifier == null) Text(TaskJudgmentCopy.verificationSubjectHint.getValue("MISSING"), style = MaterialTheme.typography.bodySmall, color = muted)
                else Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(verifier.text("title") ?: "Untitled task", Modifier.weight(1f), maxLines = 2)
                    TaskStatusPill(TaskJudgment.verifierPill(verifier))
                    OutlinedButton(onClick = { verifier.text("id")?.let { open(OrbitRoute(Destination.TASK, it)) } }) { Text(TaskJudgmentCopy.verifierCardEntry) }
                }
            }
            TaskDetailLogic.liveRun(task)?.let { live -> item(key = "now") { NowSection(task, live, data, open) } }
            data.evidence.lastOrNull()?.let { latest -> item(key = "evidence") { EvidenceSection(task, latest) } }
            // Where the task's work stands after DONE (§2.7a): the newest landing attempt and why it waits or where it stopped.
            TaskLandingLogic.status(TaskIntegrationView.of(task))?.let { landing ->
                item(key = "landing") { LandingSection(landing, open) }
            }
            // What "done" means for this task, and who decides it. Before the brief: it is the contract the run and its reader are
            // both held to. Unset, the command pair is not drawn: its "a person decides" contradicted a task judged by evidence.
            item(key = "acceptance") {
                val draft = AcceptanceDraft(task)
                val judged = draft.command.isNotBlank() && draft.exitCode.isNotBlank()
                TaskSectionHeader(TaskDetailCopy.doneMeansHeading) { TextButton(onClick = { sheet = "acceptance" }, enabled = enabled, modifier = Modifier.testTag("task-edit-acceptance")) { Text(TaskDetailCopy.edit) } }
                Column(Modifier.testTag("task-done-means"), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(TaskDetailCopy.acceptanceCriteriaLabel, style = MaterialTheme.typography.labelMedium, color = muted)
                    AcceptanceDraft.blankToNull(draft.criteria)?.let { FoldableMarkdown(it, link) } ?: Text(TaskDetailCopy.acceptanceEmpty, color = muted)
                    if (judged) {
                        Text(TaskDetailCopy.automaticJudgementLabel, style = MaterialTheme.typography.labelMedium, color = muted)
                        SelectionContainer { Text(draft.command.trim(), fontFamily = FontFamily.Monospace) }
                        Text("${TaskDetailCopy.doneWhenItExits} ${draft.exitCode.trim()}", style = MaterialTheme.typography.bodySmall, color = muted)
                        Text(TaskDetailCopy.acceptanceAutomaticHint, style = MaterialTheme.typography.bodySmall, color = muted)
                    }
                }
            }
            // Written as an agent-ready prompt, so rendered as Markdown, and folded: the page leads with the work, not the ask.
            task.text("description")?.takeIf { it.isNotEmpty() }?.let { description -> item(key = "brief") {
                TaskSectionHeader(TaskDetailCopy.briefHeading)
                Box(Modifier.testTag("task-brief")) { FoldableMarkdown(description, link, folded = 120.dp, folds = TaskDetailLogic.folds(description, lines = 5, characters = 280)) }
            } }
            if (TaskDetailLogic.hasDependencies(task)) item(key = "plan") {
                TaskSectionHeader(TaskDetailCopy.planHeading)
                Column(Modifier.testTag("task-dependencies-section"), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    TaskDetailLogic.blockedNotice(task)?.let { (text, failed) -> Text("🔒 $text", style = MaterialTheme.typography.bodySmall,
                        color = if (failed) MaterialTheme.colorScheme.error else LocalOrbitColors.current.needsYou) }
                    TaskDetailLogic.planSentence(task).takeIf { it.isNotEmpty() }?.let { Text(it, Modifier.testTag("task-plan-sentence"), style = MaterialTheme.typography.bodyMedium) }
                    Row(Modifier.fillMaxWidth().clickable(role = Role.Button) { planOpen = !planOpen }.padding(vertical = 6.dp).testTag("task-plan-toggle"),
                        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Text(if (planOpen) TaskDetailCopy.hideGraph else TaskDetailCopy.showGraph, color = MaterialTheme.colorScheme.primary)
                        Spacer(Modifier.weight(1f))
                        TaskDetailLogic.dependencySummary(task, graph)?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = muted, maxLines = 1,
                            overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false)) }
                        Text(if (planOpen) "⌄" else "›", color = muted)
                    }
                    if (planOpen) {
                        val showGraph = (dependencyView ?: if (TaskDetailLogic.prefersGraph(graph)) "graph" else "list") == "graph"
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            FilterChip(showGraph, { dependencyView = "graph" }, label = { Text(TaskDetailCopy.graphView) })
                            FilterChip(!showGraph, { dependencyView = "list" }, label = { Text(TaskDetailCopy.listView) }, modifier = Modifier.testTag("task-dependency-list"))
                        }
                        if (showGraph) TaskDependencyGraphView(TaskDetailLogic.graphMarks(graph), graph.text("focusTaskId") ?: id) { open(OrbitRoute(Destination.TASK, it)) }
                        else TaskDetailLogic.dependencyRows(graph).forEach { dependency -> DependencyRowView(dependency, enabled, open) { confirm = DetailConfirm.RemovePrerequisite(dependency) } }
                        TaskDetailLogic.truncationNotice(graph)?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = muted) }
                        if (task.objects("dependsOn").isNotEmpty()) Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(TaskDetailCopy.autoRunWhenReady, Modifier.weight(1f))
                            Switch(task["autoRunWhenReady"] != JsonPrimitive(false), { patch(buildJsonObject { put("autoRunWhenReady", it) }) }, enabled = enabled,
                                modifier = Modifier.testTag("task-auto-run"))
                        }
                        TextButton(onClick = { sheet = "dependency" }, enabled = enabled, modifier = Modifier.testTag("task-add-prerequisite")) { Text("＋ ${TaskDetailCopy.addPrerequisite}") }
                    }
                }
            }
            // Who runs the task and on what, as one line at rest: pressing it opens the fields in a sheet (board 05 D).
            item(key = "runs-with") {
                val pins = RunPins(task, data, assigneeWorkspace, smartSelection)
                TaskSectionHeader(TaskDetailCopy.runsWithHeading)
                Row(Modifier.fillMaxWidth().clickable(role = Role.Button) { sheet = "runs-with" }.padding(vertical = 6.dp).testTag("task-runs-with"),
                    verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(envelopeLine(task, pins, muted), Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                    Text("›", color = muted)
                }
                Text(envelopeNote(task, data), style = MaterialTheme.typography.bodySmall, color = muted)
            }
            if (task.objects("attachments").isNotEmpty()) item(key = "inputs") { InputsSection(app, handle, task, enabled, { viewing = it }, { confirm = DetailConfirm.RemoveInput(it) }) { message ->
                if (message != null) data.error = message; scope.launch { load() } } }
            data.attribution?.takeIf { TaskDetailLogic.attributionNeedsCard(it, task.text("projectId")) }?.let { view -> item(key = "attribution") {
                TaskSectionHeader(TaskDetailCopy.attributionHeading)
                TaskDetailLogic.attributionRows(view).forEach { fact -> AttributionRowView(fact, open) }
            } }
            // Drawn only when anything follows the task, live or ended; Follow task is in ⋯.
            if (followers.isNotEmpty() || endedWatches > 0) item(key = "followed") {
                TaskSectionHeader(TaskDetailCopy.followedByHeading, "${followers.size}")
                if (followers.isEmpty()) Text(TaskDetailCopy.nothingWatching, color = muted)
                else followers.forEach { watch -> Column(Modifier.fillMaxWidth().clickable(role = Role.Button) {
                    watch.text("id")?.let { open(OrbitRoute(Destination.WATCH, it)) } }.padding(vertical = 6.dp)) {
                    Text(TaskFollow.condition(watch.obj("predicate")))
                    Text(listOf(if (watch.text("state") == "PAUSED") "Paused" else "Watching", "Notify you").joinToString(" · "),
                        style = MaterialTheme.typography.bodySmall, color = muted)
                } }
                if (endedWatches > 0) Text(TaskDetailCopy.endedWatches(endedWatches), style = MaterialTheme.typography.labelMedium, color = muted)
                TextButton(onClick = { sheet = "follow" }, enabled = enabled) { Text("👁 ${TaskDetailCopy.followTask}") }
            }
            // One timeline: when the task was filed, its runs, its evidence and decisions, and the comments — oldest first, so the
            // newest sits above the comment box.
            item(key = "activity-head") { TaskSectionHeader(TaskDetailCopy.activityHeading, modifier = Modifier.testTag("task-activity")) }
            items(TaskDetailLogic.activity(task, data.evidence), key = { "activity:${it.key}" }) { entry ->
                when (entry) {
                    is TaskActivityItem.Filed -> FiledRow(task, entry.at, workspaces, open)
                    is TaskActivityItem.Run -> RunRow(entry.session, task, data, open) { sheet = "why:${entry.session.text("id")}" }
                    is TaskActivityItem.Comment -> CommentRow(entry.comment, link)
                    else -> Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(TaskDetailLogic.activityText(entry).orEmpty(), Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
                        entry.at?.let(TaskTime::relative)?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = muted) }
                    }
                }
            }
        }
        // The comment box stays on screen: asking an agent about this task is one tap away.
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.Bottom) {
            if (recipient != null) Box(Modifier.padding(bottom = 8.dp, end = 6.dp)) {
                val tint = if (toRun) MaterialTheme.colorScheme.primary else muted
                Text("${if (toRun) TaskDetailCopy.toTheRun else TaskDetailCopy.comment} ⌄", Modifier.background(tint.copy(alpha = 0.12f), RoundedCornerShape(50))
                    .clickable(role = Role.Button) { targetMenu = true }.padding(horizontal = 10.dp, vertical = 7.dp).testTag("task-compose-target"),
                    style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, color = tint)
                DropdownMenu(targetMenu, { targetMenu = false }) {
                    DropdownMenuItem(text = { Text(TaskDetailCopy.toTheRun) }, onClick = { targetMenu = false; composeToRun = true })
                    DropdownMenuItem(text = { Text(TaskDetailCopy.comment) }, onClick = { targetMenu = false; composeToRun = false })
                }
            }
            OutlinedTextField(comment, { TaskCommentDrafts[draft] = it }, Modifier.weight(1f).testTag("task-comment"),
                placeholder = { Text(if (toRun) TaskDetailCopy.messageWhileItWorks(task.obj("assignee")?.text("name") ?: TaskDetailCopy.theAgentInASentence)
                    else TaskDetailCopy.commentPlaceholder, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                maxLines = 4, shape = RoundedCornerShape(22.dp))
            TextButton(onClick = {
                val body = comment.trim()
                val to = if (toRun) recipient else null
                if (body.isNotEmpty()) mutate {
                    api.addComment(id, body, TaskDetailLogic.mentions(mentionedWorkspaceIds(body, workspaces), to), revisionOf(task) + ":" + body)
                    TaskCommentDrafts.sent(draft, body)
                    if (to != null) data.notice = TaskDetailCopy.sentToTheRun
                }
            }, enabled = enabled && comment.isNotBlank(), modifier = Modifier.testTag("task-post-comment").semantics { contentDescription = "Send comment" }) { Text("➤") }
        }
    }

    confirm?.let { pending ->
        val (title, body, action) = when (pending) {
            DetailConfirm.Delete -> Triple(TaskListCopy.deleteTitle, TaskListCopy.deleteMessage, TaskDetailCopy.deleteTask)
            DetailConfirm.Reopen -> Triple(TaskReopenCopy.modalTitle, TaskReopen.paragraphs(task).joinToString("\n\n"), TaskReopenCopy.modalOK)
            is DetailConfirm.RemoveInput -> Triple(TaskDetailCopy.removeInputTitle, TaskDetailCopy.removeInputDetail, TaskDetailCopy.remove)
            is DetailConfirm.RemovePrerequisite -> Triple(TaskDetailCopy.removePrerequisiteTitle, TaskDetailCopy.removePrerequisiteDetail, TaskDetailCopy.remove)
        }
        AlertDialog(onDismissRequest = { confirm = null }, title = { Text(title) }, text = { Text(body) },
            confirmButton = { TextButton(onClick = {
                confirm = null
                when (pending) {
                    // Back only from this page: answered after it was left, it must not pop whatever is shown now.
                    DetailConfirm.Delete -> mutate { api.delete(id, revisionOf(task)); if (data.attached) back() }
                    DetailConfirm.Reopen -> mutate { api.reopen(id, revisionOf(task)) }
                    is DetailConfirm.RemoveInput -> mutate { api.removeInput(pending.input.text("id").orEmpty(), revisionOf(task)) }
                    is DetailConfirm.RemovePrerequisite -> mutate { api.removeDependency(id, pending.row.id, revisionOf(task)) }
                }
            }, enabled = enabled, modifier = Modifier.testTag("task-confirm")) {
                Text(action, color = if (pending == DetailConfirm.Reopen) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error)
            } },
            dismissButton = { TextButton(onClick = { confirm = null }) { Text(TaskDetailCopy.cancel) } })
    }
    viewing?.let { input -> AttachmentActions(input.text("fileName") ?: "attachment", input.text("mimeType") ?: "application/octet-stream",
        bytes = { app.session.request(handle, ApiRequest(listOf("attachments", input.text("id").orEmpty()), maxResponseBytes = 25L * 1024 * 1024)).body },
        close = { viewing = null }) }
    when (val current = sheet) {
        null -> Unit
        "runs-with" -> RunsWithSheet(app, handle, task, data, workspaces, assigneeWorkspace, enabled, close = ::closeSheet, edit = { sheet = it },
            pin = { pin(it) }, view = { viewing = it }, remove = { confirm = DetailConfirm.RemoveInput(it) },
            uploaded = { message -> if (message != null) data.error = message; scope.launch { load() } }) { fields -> patch(fields) }
        "share" -> ShareSheet(app, handle, ShareRootKind.TASK, id, close = { sheet = null }) { data.share = it }
        // Each sheet stays up until the server takes what it sent (iOS `TaskDetailParts`), so a refusal
        // — an override reason the server asks for, the account going offline, an unknown answer —
        // leaves what was typed where it was, with the server's words under it.
        // A sheet cannot be put away while what it sent is out: its answer is shown under it.
        "schedule" -> ScheduleSheet(task, enabled, data.sheetError, sending = data.busy, close = ::closeSheet) { runAt ->
            patch(buildJsonObject { put("runAt", runAt?.let(::JsonPrimitive) ?: JsonNull) },
                if (runAt == null) TaskDetailCopy.scheduleCancelled else TaskDetailCopy.scheduleSaved, fromSheet = "schedule") { closeSheet() }
        }
        "acceptance" -> AcceptanceSheet(AcceptanceDraft(task), enabled, data.sheetError, sending = data.busy, close = ::closeSheet) { fields ->
            patch(fields, TaskDetailCopy.acceptanceSaved, fromSheet = "acceptance") { closeSheet() }
        }
        "follow" -> FollowSheet(task, enabled, data.sheetError, sending = data.busy, close = ::closeSheet) { predicate, ttl, key ->
            mutate(fromSheet = "follow", done = { closeSheet() }) {
                val watch = api.follow(id, predicate, ttl, key)
                data.notice = if (watch?.text("state") == "MATCHED") TaskDetailCopy.followMatchedAtOnce else TaskDetailCopy.following
            }
        }
        "dependency" -> DependencyPicker(api, id, task.objects("dependsOn").mapNotNull { it.obj("dependsOnTask")?.text("id") }, enabled, data.sheetError,
            sending = data.busy, close = ::closeSheet) { prerequisite ->
            mutate(fromSheet = "dependency", done = { closeSheet() }) { api.addDependency(id, prerequisite, revisionOf(task)) }
        }
        else -> if (current.startsWith("why:")) task.objects("sessions").firstOrNull { it.text("id") == current.removePrefix("why:") }?.let { run ->
            TaskDetailLogic.runRoute(run, LocalSmartSelection.current)?.let { route -> RouteWhySheet(route, { modelName(it, task, data) }) { sheet = null } }
        } ?: run { sheet = null }
    }
}

/** The two presses under the title, and the reason a run cannot start when it cannot — or, when it can, that it is the task's only start. */
@Composable
private fun ActionRow(row: TaskActionRow, canStart: Boolean, enabled: Boolean, task: JsonObject, assigneeHasRunner: Boolean,
    open: (OrbitRoute) -> Unit, run: () -> Unit, confirmDone: () -> Unit) {
    if (row.isEmpty) return
    val needsYou = LocalOrbitColors.current.needsYou
    val leading: (@Composable (Modifier) -> Unit)? = row.leading?.let { leading -> { modifier ->
        when (leading) {
            is TaskActionRow.Leading.Waiting -> Button(onClick = { open(OrbitRoute(Destination.SESSION, leading.sessionId)) }, modifier.testTag("task-owner-waiting"),
                colors = ButtonDefaults.buttonColors(containerColor = needsYou)) { Text(OwnerConfirmationCopy.waitingForConfirmation, maxLines = 1) }
            is TaskActionRow.Leading.UnderReview -> OutlinedButton(onClick = { open(OrbitRoute(Destination.SESSION, leading.sessionId)) }, modifier.testTag("task-owner-review")) {
                Text("◷ ${OwnerConfirmationCopy.underReview}", maxLines = 1) }
            TaskActionRow.Leading.ConfirmDone -> OutlinedButton(onClick = confirmDone, modifier.testTag("task-confirm-done"), enabled = enabled) { Text(OwnerConfirmationCopy.confirmAction, maxLines = 1) }
        }
    } }
    val trailing: (@Composable (Modifier, Boolean) -> Unit)? = row.trailing?.let { trailing -> { modifier, prominent ->
        val label = when (trailing) {
            is TaskActionRow.Trailing.OpenRun -> TaskRunHandoff.openTheRun
            TaskActionRow.Trailing.RunNow -> TaskDetailCopy.runNow
            TaskActionRow.Trailing.Retry -> TaskRunHandoff.retryEntryLabel
            TaskActionRow.Trailing.Gate -> TaskJudgmentCopy.gateActionLabel
        }
        val press: () -> Unit = if (trailing is TaskActionRow.Trailing.OpenRun) ({ trailing.sessionId?.let { open(OrbitRoute(Destination.SESSION, it)) } }) else run
        val on = if (trailing is TaskActionRow.Trailing.OpenRun) trailing.sessionId != null else canStart && enabled
        if (prominent) Button(onClick = press, modifier.testTag("task-run"), enabled = on) { Text(label, maxLines = 1, overflow = TextOverflow.Ellipsis) }
        else OutlinedButton(onClick = press, modifier.testTag("task-run"), enabled = on) { Text(label, maxLines = 1, overflow = TextOverflow.Ellipsis) }
    } }
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (row.stacked) { leading?.invoke(Modifier.fillMaxWidth()); trailing?.invoke(Modifier.fillMaxWidth(), false) }
        else Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            leading?.invoke(Modifier.weight(1f))
            trailing?.invoke(Modifier.weight(1f), true)
        }
        val trailingKind = row.trailing
        if (trailingKind != null && trailingKind !is TaskActionRow.Trailing.OpenRun)
            (if (canStart) TaskDetailLogic.runNowHint(task) else TaskDetailLogic.runDisabledHint(task, assigneeHasRunner))?.let {
                Text(it, Modifier.testTag("task-run-hint"), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}

/** The task's Landing section (§2.7a, web `LandTaskStatus`): the badge, the generation, the step it
 * is on or stopped at, a silent runner's report, the reason and the receipt, the six facts — then
 * the one way into its landing session. Read-only: no retry, merge or release door lives here. */
@Composable
private fun LandingSection(status: TaskLandingStatus, open: (OrbitRoute) -> Unit) {
    TaskSectionHeader(TaskLandingCopy.landingSection, status.generation?.let { "${TaskLandingCopy.generation} $it" })
    Column(Modifier.fillMaxWidth().testTag("task-landing"), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            status.badge?.let { badge ->
                val ink = landingInk(badge.tone)
                Text(badge.label, Modifier.testTag("task-landing-badge").background(ink.copy(alpha = 0.14f), RoundedCornerShape(50))
                    .padding(horizontal = 8.dp, vertical = 2.dp), style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold, color = ink)
            }
            status.step?.let { Text(it, Modifier.testTag("task-landing-step"), style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2) }
        }
        status.noReport?.let { Text(it, Modifier.testTag("task-landing-no-report"), style = MaterialTheme.typography.labelMedium,
            fontWeight = FontWeight.SemiBold, color = LocalOrbitColors.current.needsYou) }
        status.reason?.let { Text(it, Modifier.testTag("task-landing-reason"), style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant) }
        status.receipt?.let { Text(it, Modifier.testTag("task-landing-receipt"), style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant) }
        if (status.facts.isNotEmpty()) Column(Modifier.testTag("task-landing-facts"), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            status.facts.forEach { fact ->
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(fact.label, Modifier.width(92.dp), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(fact.value, style = MaterialTheme.typography.labelMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
        TaskLandingLogic.route(status)?.let { route ->
            TextButton(onClick = { open(route) }, modifier = Modifier.testTag("task-landing-open")) { Text("${TaskLandingCopy.openLanding} ›") }
        }
    }
}

@Composable
private fun landingInk(tone: String): Color = when (tone) {
    "amber" -> LocalOrbitColors.current.needsYou
    "blue" -> LocalOrbitColors.current.running
    "green" -> LocalOrbitColors.current.success
    "red" -> MaterialTheme.colorScheme.error
    else -> MaterialTheme.colorScheme.onSurfaceVariant
}

/** What the run pins read (board 6): first the engine — unpinned it follows what the assignee's project last ran — then a credential
 * that engine runs, then a model of the pair (docs/provider-engine-contract.md §1.2). The Runs with line and its sheet read the same. */
private class RunPins(val task: JsonObject, val data: TaskDetailData, assignee: JsonObject?, val smartSelection: Boolean) {
    val catalog = data.runner?.let { ComposerCatalog(it, data.providers) }
    val assigneeProvider = assignee?.text("lastProvider") ?: assignee?.text("provider") ?: ProviderEngines.CLAUDE
    val assigneeEngine = ProviderEngines.sessionEngine(assignee?.text("lastEngine"), assigneeProvider, data.providers)
    val pinnedProvider = task.text("provider")
    val pinnedEngine = task.text("engine")?.takeIf(ProviderEngines::isEngine)
    // A credential pinned alone, by an older client, runs on its default engine.
    val runEngine = pinnedEngine ?: pinnedProvider?.let { ProviderEngines.defaultEngineOf(it, data.providers) } ?: assigneeEngine
    val engineValue = if (pinnedEngine == null && pinnedProvider == null) "${EngineCopy.ASSIGNEES} · ${ProviderEngines.cliName(assigneeEngine)}"
        else ProviderEngines.cliName(runEngine)
    // Past the engine's default credential — its own sign-in on the runner, OpenCode's own configuration, DeepSeek Harness's first
    // DeepSeek key, which "Engine default" stands for — the account pools and the keys the engine runs. A pinned credential it no
    // longer lists stays on top, so the row still says what is pinned.
    val credentials = catalog?.credentials(runEngine).orEmpty().filter { it.kind == CredentialKind.POOL || it.kind == CredentialKind.KEY }
    val firstDeepSeekKey = catalog?.credentials(ProviderEngines.DSH)?.firstOrNull { it.kind == CredentialKind.KEY }
    val runnerName = data.runner?.let(RunnerPage::displayName)
    val engineDefault = when (runEngine) {
        ProviderEngines.DSH -> firstDeepSeekKey?.label ?: EngineCopy.FIRST_DEEPSEEK_KEY
        ProviderEngines.OPENCODE -> EngineCopy.OPENCODE_OWN
        else -> runnerName?.let(EngineCopy::signInOn) ?: EngineCopy.RUNNER_SIGN_IN
    }
    fun pinLabel(slug: String) = credentials.firstOrNull { it.id == slug }?.label ?: when {
        slug in ProviderEngines.LOGIN_ENGINES -> (runnerName?.let(EngineCopy::signInOn) ?: EngineCopy.RUNNER_SIGN_IN).replaceFirstChar { it.uppercase() }
        slug == ProviderEngines.OPENCODE -> EngineCopy.OPENCODE_OWN
        else -> data.providers.firstOrNull { it.text("slug") == slug }?.text("label") ?: slug
    }
    val providerValue = pinnedProvider?.let(::pinLabel) ?: "${EngineCopy.ENGINE_DEFAULT} · $engineDefault"
    val offList = pinnedProvider?.takeIf { slug -> credentials.none { it.id == slug } }
    val pools = credentials.filter { it.kind == CredentialKind.POOL }
    val keys = credentials.filter { it.kind == CredentialKind.KEY }
    // The credential whose model space the Model row lists: the task's own pin, the engine's default credential under an engine
    // pinned alone, else the assignee's.
    val runProvider = pinnedProvider ?: pinnedEngine?.let { engine -> if (engine == ProviderEngines.DSH) firstDeepSeekKey?.id ?: engine else engine }
        ?: assigneeProvider
    val models = catalog?.models(runEngine, runProvider).orEmpty()
    val unpinned = if (smartSelection && assignee?.flag("modelRouting") == true) TaskDetailCopy.smartSelectionPlaceholder else TaskDetailCopy.providerDefault
    val modelValue = task.text("model")?.let { m -> models.firstOrNull { it.text("value") == m }?.text("label") ?: m } ?: unpinned
}

/** `Agent orbit-develop · Engine Claude Code · Provider … · Model …`, labels in grey. */
private fun envelopeLine(task: JsonObject, pins: RunPins, muted: Color): AnnotatedString = buildAnnotatedString {
    listOf(TaskDetailCopy.agentLabel to (task.obj("assignee")?.text("name") ?: TaskListCopy.unassigned), EngineCopy.ENGINE to pins.engineValue,
        TaskDetailCopy.providerLabel to pins.providerValue, TaskDetailCopy.modelLabel to pins.modelValue).forEachIndexed { index, (label, value) ->
        if (index > 0) withStyle(SpanStyle(color = muted)) { append("  ·  ") }
        withStyle(SpanStyle(color = muted)) { append("$label ") }
        append(value)
    }
}

/** Under the line: the list, the schedule when there is one, and the inputs. */
private fun envelopeNote(task: JsonObject, data: TaskDetailData): String {
    val list = data.lists.firstOrNull { ObjectId.same(it.text("id"), task.text("listId")) }?.text("title")
    val inputs = task.objects("attachments").size
    return listOfNotNull(list?.let { "List: $it" } ?: TaskListCopy.noList,
        task.text("runAt")?.let { "${TaskDetailCopy.startAtLabel} ${TaskDetailLogic.scheduleValue(it)}" },
        if (inputs == 0) TaskDetailCopy.noInputFiles else "$inputs input ${if (inputs == 1) "file" else "files"}").joinToString(" · ")
}

/** The Runs with fields, as form rows in a sheet: the label on the left, the value in grey with its chooser mark. Start at opens its
 * own sheet from here, and the inputs are listed under them. */
@Composable
private fun RunsWithSheet(app: OrbitApplication, handle: SessionHandle, task: JsonObject, data: TaskDetailData, workspaces: List<JsonObject>,
    assignee: JsonObject?, enabled: Boolean, close: () -> Unit, edit: (String) -> Unit, pin: (TaskPin) -> Unit, view: (JsonObject) -> Unit,
    remove: (JsonObject) -> Unit, uploaded: (String?) -> Unit, patch: (JsonObject) -> Unit) {
    val smartSelection = LocalSmartSelection.current
    val pins = RunPins(task, data, assignee, smartSelection)
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    AlertDialog(onDismissRequest = close, title = { Text(TaskDetailCopy.runsWithHeading) }, modifier = Modifier.testTag("task-runs-with-sheet"),
        text = { Column(Modifier.verticalScroll(rememberScrollState()).testTag("task-details"), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            val currentAssignee = task.obj("assignee")
            PickerRow(TaskDetailCopy.assigneeLabel, currentAssignee?.text("name") ?: TaskListCopy.unassigned, enabled,
                listOf<Pair<String?, String>>(null to TaskListCopy.unassigned) + orderedWorkspaceRows(workspaces).map { it.text("id") to (it.text("name") ?: "Workspace") } +
                    listOfNotNull(currentAssignee?.takeIf { a -> workspaces.none { ObjectId.same(it.text("id"), a.text("id")) } }?.let { it.text("id") to (it.text("name") ?: it.text("id").orEmpty()) }),
                tag = "task-assignee") { patch(buildJsonObject { put("assigneeId", it?.let(::JsonPrimitive) ?: JsonNull) }) }
            // The account's switch for smart model selection, off by default: then none of it is drawn here — no Suggested, no ✦
            // placeholder, no coordinator's reason — as on the web and iOS (9fb3ae6ee).
            val picks = TaskDetailLogic.modelHintPicks(task.objects("modelHintOptions"))
            if (smartSelection) PickerRow(TaskDetailCopy.suggestedLabel, picks.firstOrNull { it.value == task.text("modelHint") }?.label ?: task.text("modelHint") ?: TaskDetailCopy.noSuggestion,
                enabled, picks.map { it.value to it.label }, details = picks.associate { it.value to it.detail }, tag = "task-suggested") { patch(TaskDetailLogic.modelHintRequest(it)) }
            PickerRow(EngineCopy.ENGINE, pins.engineValue, enabled,
                listOf<Pair<String?, String>>(null to EngineCopy.ASSIGNEES) +
                    // Cursor CLI once a runner of the account knows it, as every list of engines offers it.
                    ProviderEngines.ALL_ENGINES.filter { ProviderEngines.androidShowsEngine(it, data.runners + listOfNotNull(data.runner)) }
                        .map { it to ProviderEngines.cliName(it) },
                details = mapOf(null to ProviderEngines.cliName(pins.assigneeEngine)), tag = "task-engine") { engine ->
                TaskPins.engine(engine, pins.pinnedEngine, pins.pinnedProvider, ProviderEngines.providerEngines(pins.pinnedProvider, data.providers))?.let(pin)
            }
            PickerRow(TaskDetailCopy.providerLabel, pins.providerValue, enabled,
                listOf<Pair<String?, String>>(null to EngineCopy.ENGINE_DEFAULT) + listOfNotNull(pins.offList?.let { it to pins.pinLabel(it) }) +
                    (pins.pools + pins.keys).map { it.id to it.label },
                details = mapOf<String?, String>(null to when (pins.runEngine) {
                    ProviderEngines.DSH -> EngineCopy.FIRST_DEEPSEEK_KEY; ProviderEngines.OPENCODE -> EngineCopy.OWN_SIGN_IN; else -> EngineCopy.RUNNER_SIGN_IN
                }) + pins.credentials.mapNotNull { option -> option.unavailable?.let { option.id to it } },
                headers = listOfNotNull(pins.pools.firstOrNull()?.let { it.id to EngineCopy.ACCOUNT_POOLS },
                    pins.keys.firstOrNull()?.let { it.id to if (pins.runEngine == ProviderEngines.DSH) EngineCopy.YOUR_DEEPSEEK_KEYS else EngineCopy.YOUR_KEYS }).toMap(),
                tag = "task-provider") { slug -> TaskPins.provider(slug, pins.pinnedProvider, pins.runEngine)?.let(pin) }
            PickerRow(TaskDetailCopy.modelLabel, pins.modelValue, enabled,
                listOf<Pair<String?, String>>(null to pins.unpinned) + pins.models.map { it.text("value") to (it.text("label") ?: it.text("value").orEmpty()) } +
                    listOfNotNull(task.text("model")?.takeIf { m -> pins.models.none { it.text("value") == m } }?.let { it to it }), tag = "task-model") {
                patch(buildJsonObject { put("model", it?.let(::JsonPrimitive) ?: JsonNull) })
            }
            PickerRow(TaskDetailCopy.listLabel, data.lists.firstOrNull { ObjectId.same(it.text("id"), task.text("listId")) }?.text("title")
                ?: task.text("listId")?.let { "Task List" } ?: TaskListCopy.noList, enabled,
                listOf<Pair<String?, String>>(null to TaskListCopy.noList) + data.lists.map { it.text("id") to (it.text("title") ?: "Task List") }, tag = "task-list") {
                patch(buildJsonObject { put("listId", it?.let(::JsonPrimitive) ?: JsonNull) })
            }
            DetailRow(TaskDetailCopy.startAtLabel, TaskDetailLogic.scheduleValue(task.text("runAt")), "⌄", enabled, "task-start-at") { edit("schedule") }
            // The coordinator's reason for the suggested tier, in grey under the fields.
            if (smartSelection) TaskDetailLogic.modelHintNote(task)?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = muted) }
            if (TaskListLogic.isBusy(task)) Text(TaskDetailCopy.changesApplyToNextRun, style = MaterialTheme.typography.bodySmall, color = muted)
            InputsSection(app, handle, task, enabled, view, remove, uploaded)
        } },
        confirmButton = { TextButton(onClick = close, modifier = Modifier.testTag("task-runs-with-done")) { Text(TaskDetailCopy.done) } })
}

/** The task's input files: on the page when there are some, and in the Runs with sheet. */
@Composable
private fun InputsSection(app: OrbitApplication, handle: SessionHandle, task: JsonObject, enabled: Boolean, view: (JsonObject) -> Unit,
    remove: (JsonObject) -> Unit, uploaded: (String?) -> Unit) {
    val inputs = task.objects("attachments")
    Column {
        TaskSectionHeader(TaskDetailCopy.inputsHeading, "${inputs.size}")
        Text(TaskDetailCopy.inputsHint, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        inputs.forEach { input ->
            Row(Modifier.fillMaxWidth().clickable(role = Role.Button) { view(input) }.padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(if (input.text("mimeType").orEmpty().startsWith("image/")) "🖼" else "📄")
                Column(Modifier.weight(1f)) {
                    Text(input.text("fileName") ?: input.text("mimeType").orEmpty(), maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
                    Text(TaskDetailLogic.humanSize((input["sizeBytes"] as? JsonPrimitive)?.longOrNull ?: 0L), style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                TextButton(onClick = { remove(input) }, enabled = enabled, modifier = Modifier.semantics { contentDescription = "Remove input" }) { Text("✕") }
            }
        }
        TaskInputUpload(app, handle, task.text("id").orEmpty(), enabled, uploaded)
    }
}

/** What the agent is doing now: the run that is going and the position it last reported (`task_progress_report`). The card is
 * the way into the run, as the header's press is. */
@Composable
private fun NowSection(task: JsonObject, run: JsonObject, data: TaskDetailData, open: (OrbitRoute) -> Unit) {
    val name = run.obj("agent")?.text("name") ?: task.obj("assignee")?.text("name") ?: TaskDetailCopy.theAgent
    val progress = TaskDetailLogic.progress(task)
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    TaskSectionHeader(TaskDetailCopy.nowHeading)
    Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f), RoundedCornerShape(12.dp))
        .clickable(role = Role.Button) { run.text("id")?.let { open(OrbitRoute(Destination.SESSION, it)) } }.padding(12.dp).testTag("task-now"),
        verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            Avatar(name)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(if (resolvedRunState(run) == "RUNNING") TaskDetailCopy.isWorking(name) else TaskDetailLogic.runLabel(run),
                    style = MaterialTheme.typography.bodyMedium, fontWeight = FontWeight.SemiBold)
                // `Started 7m ago · Opus 5.5 · $0.84 so far`.
                Text(listOfNotNull(run.text("createdAt")?.let(TaskTime::relative)?.let { "Started $it" }, run.text("model")?.let { modelName(it, task, data) },
                    TaskDetailLogic.costLabel(TaskDetailLogic.runCost(run))?.let { "$it so far" }).joinToString(" · "),
                    style = MaterialTheme.typography.labelMedium, color = muted, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Text("›", color = muted)
        }
        progress?.let { reported ->
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                TaskDetailLogic.progressStep(reported)?.let { Text(it, style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold) }
                reported.text("phase")?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = muted, maxLines = 2) }
            }
            TaskDetailLogic.progressFraction(reported)?.let { LinearProgressIndicator(progress = { it }, modifier = Modifier.fillMaxWidth()) }
            reported.text("message")?.let { Text(it, Modifier.fillMaxWidth().background(muted.copy(alpha = 0.1f), RoundedCornerShape(8.dp)).padding(8.dp),
                style = MaterialTheme.typography.bodySmall) }
            reported.text("lastProgressAt")?.let(TaskTime::relative)?.let { Text("Last progress $it", style = MaterialTheme.typography.labelMedium, color = muted) }
        }
    }
}

/** What the work delivered, and on what grounds: the newest evidence version and its decision. */
@Composable
private fun EvidenceSection(task: JsonObject, row: JsonObject) {
    val (label, accepted) = TaskDetailLogic.evidenceOutcome(row)
    val tint = when (accepted) { true -> LocalOrbitColors.current.success; false -> LocalOrbitColors.current.needsYou; null -> MaterialTheme.colorScheme.onSurfaceVariant }
    val envelope = row.obj("evidence")
    val gaps = (envelope?.get("gaps") as? JsonArray).orEmpty().mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
    TaskSectionHeader(if (task.text("status") == "DONE") TaskDetailCopy.deliveredHeading else TaskDetailCopy.evidenceHeading)
    Column(Modifier.fillMaxWidth().testTag("task-evidence"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Text(label, Modifier.background(tint.copy(alpha = 0.15f), RoundedCornerShape(50)).padding(horizontal = 7.dp, vertical = 2.dp),
                style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold, color = tint)
            Text(TaskDetailLogic.evidenceMeta(row) { iso -> iso?.let(TaskTime::relative).orEmpty() }, style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2)
        }
        envelope?.text("claim")?.trim()?.takeIf { it.isNotEmpty() }?.let { claim ->
            Row(Modifier.height(IntrinsicSize.Min)) {
                Box(Modifier.width(3.dp).fillMaxHeight().background(tint.copy(alpha = 0.4f)))
                Text(claim, Modifier.padding(start = 9.dp), style = MaterialTheme.typography.bodyMedium, maxLines = 5, overflow = TextOverflow.Ellipsis)
            }
        }
        envelope?.objects("checks").orEmpty().forEach { check ->
            val succeeded = (check["succeeded"] as? JsonPrimitive)?.booleanOrNull
            Row(horizontalArrangement = Arrangement.spacedBy(7.dp)) {
                Text(when (succeeded) { false -> "✕"; true -> "✓"; null -> "•" }, Modifier.width(14.dp), fontWeight = FontWeight.Bold,
                    color = if (succeeded == false) MaterialTheme.colorScheme.error else LocalOrbitColors.current.success)
                SelectionContainer { Text(TaskDetailLogic.evidenceCheckText(check), style = MaterialTheme.typography.bodySmall,
                    fontFamily = if (check.text("kind") == "TOOL_CALL") FontFamily.Monospace else null) }
            }
        }
        if (gaps.isNotEmpty()) Text(TaskDetailCopy.notCovered + gaps.joinToString("; "), style = MaterialTheme.typography.labelMedium,
            color = LocalOrbitColors.current.needsYou)
        row.obj("decision")?.takeIf { it.text("decision") == "SEND_BACK" }?.text("note")?.takeIf { it.isNotEmpty() }?.let {
            Text(it, style = MaterialTheme.typography.labelMedium, color = LocalOrbitColors.current.needsYou) }
    }
}

/** `Filed by orbit · from <session>`: who made the task, and the conversation it came from. */
@Composable
private fun FiledRow(task: JsonObject, at: String?, workspaces: List<JsonObject>, open: (OrbitRoute) -> Unit) {
    val creator = task.text("creatorName") ?: workspaces.firstOrNull { task.text("creatorType") == "AGENT" && ObjectId.same(it.text("id"), task.text("creatorId")) }?.text("name")
    Row(Modifier.fillMaxWidth().padding(vertical = 4.dp).testTag("task-filed"), verticalAlignment = Alignment.Top) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(buildAnnotatedString { withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(TaskDetailCopy.filed) }; creator?.let { append(" by $it") } },
                style = MaterialTheme.typography.bodyMedium)
            task.obj("creatorSession")?.let { source -> Text("from ${source.text("title") ?: TaskDetailCopy.untitledSession}",
                Modifier.clickable(role = Role.Button) { source.text("id")?.let { open(OrbitRoute(Destination.SESSION, it)) } }.testTag("task-created-from"),
                style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary, maxLines = 1, overflow = TextOverflow.Ellipsis) }
        }
        at?.let(TaskTime::relative)?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}

/** A comment on the timeline. */
@Composable
private fun CommentRow(entry: JsonObject, link: (String) -> Unit) {
    Column(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            Avatar(entry.text("authorName"))
            Text(entry.text("authorName") ?: "Unknown", style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold)
            entry.text("createdAt")?.let(TaskTime::relative)?.let { Text("· $it", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
        FoldableMarkdown(entry.text("body").orEmpty(), link)
    }
}

/** A form row: the label, the value in grey with its chooser mark, and a menu of choices. */
@Composable
private fun PickerRow(label: String, value: String, enabled: Boolean, options: List<Pair<String?, String>>, details: Map<String?, String> = emptyMap(),
    headers: Map<String?, String> = emptyMap(), tag: String, choose: (String?) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        DetailRow(label, value, "⇕", enabled, tag) { open = true }
        DropdownMenu(open, { open = false }) {
            options.distinctBy { it.first }.forEach { (option, title) ->
                // A group's name over its first row (board 6 ②: Account pools, Your keys), never a choice itself.
                headers[option]?.let { Text(it, Modifier.padding(horizontal = 12.dp, vertical = 6.dp), style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant) }
                DropdownMenuItem(text = { Column {
                Text(title); details[option]?.takeIf { it.isNotEmpty() }?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
            } }, onClick = { open = false; choose(option) }) }
        }
    }
}

@Composable
private fun DetailRow(label: String, value: String, glyph: String, enabled: Boolean, tag: String, press: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(enabled = enabled, role = Role.Button, onClick = press).padding(vertical = 10.dp).testTag(tag),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(label)
        Spacer(Modifier.weight(1f))
        Text(value, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
        Text(glyph, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun DependencyRowView(row: DependencyRow, enabled: Boolean, open: (OrbitRoute) -> Unit, remove: () -> Unit) {
    Row(Modifier.fillMaxWidth().testTag("dependency:${row.id}"), verticalAlignment = Alignment.Top) {
        Column(Modifier.weight(1f).clickable(enabled = !row.isFocus, role = Role.Button) { open(OrbitRoute(Destination.TASK, row.id)) }.padding(vertical = 4.dp),
            verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                TaskStatusPill(TaskDetailLogic.nodePill(row.node))
                Text(row.node.text("title").orEmpty(), maxLines = 2, fontWeight = if (row.isFocus) FontWeight.SemiBold else FontWeight.Normal,
                    modifier = Modifier.weight(1f, fill = false))
                if (row.isFocus) Text(TaskDetailCopy.currentTask, Modifier.background(MaterialTheme.colorScheme.primary.copy(alpha = 0.12f), RoundedCornerShape(50))
                    .padding(horizontal = 5.dp, vertical = 1.dp), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
            }
            Text(row.relationships, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2)
        }
        if (row.removable) TextButton(onClick = remove, enabled = enabled, modifier = Modifier.semantics {
            contentDescription = "Remove ${row.node.text("title").orEmpty()} as a prerequisite" }) { Text("✕") }
    }
}

@Composable
private fun AttributionRowView(row: AttributionRow, open: (OrbitRoute) -> Unit) {
    val target = row.link?.let { (kind, id) -> OrbitRoute(when (kind) { "project" -> Destination.PROJECT; "task" -> Destination.TASK; else -> Destination.SESSION }, id) }
    Row(Modifier.fillMaxWidth().then(if (target != null) Modifier.clickable(role = Role.Button) { open(target) } else Modifier).padding(vertical = 6.dp)
        .testTag("attribution:${row.label}"), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(row.label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(row.text, color = if (row.absent) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface)
            row.notes.forEach { Text(it, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            if (row.tags.isNotEmpty()) Row(horizontalArrangement = Arrangement.spacedBy(5.dp)) { row.tags.forEach { tag ->
                Text(tag, Modifier.background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(5.dp)).padding(horizontal = 5.dp, vertical = 1.dp),
                    style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.SemiBold, color = MaterialTheme.colorScheme.onSurfaceVariant)
            } }
        }
        if (target != null) Text("›", color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

private fun modelName(id: String, task: JsonObject, data: TaskDetailData): String =
    task.objects("modelHintOptions").firstOrNull { it.text("model") == id }?.text("label")?.takeIf { it.isNotEmpty() }
        ?: (data.runner?.get("modelCatalog") as? JsonObject)?.values?.flatMap { (it as? JsonArray).orEmpty() }?.filterIsInstance<JsonObject>()
            ?.firstOrNull { it.text("value") == id }?.text("label") ?: id

/** One run: who ran it and when, where it stands with what it ran on, and its tier when routed. */
@Composable
private fun RunRow(run: JsonObject, task: JsonObject, data: TaskDetailData, open: (OrbitRoute) -> Unit, why: () -> Unit) {
    val state = resolvedRunState(run)
    val color = when (state) { "RUNNING" -> LocalOrbitColors.current.running; "QUEUED", "AWAITING_INPUT" -> LocalOrbitColors.current.needsYou
        "SUCCEEDED" -> LocalOrbitColors.current.success; "FAILED" -> MaterialTheme.colorScheme.error; else -> MaterialTheme.colorScheme.onSurfaceVariant }
    val smartSelection = LocalSmartSelection.current
    val route = TaskDetailLogic.runRoute(run, smartSelection)
    val name: (String) -> String = { modelName(it, task, data) }
    Row(Modifier.fillMaxWidth().clickable(role = Role.Button) { run.text("id")?.let { open(OrbitRoute(Destination.SESSION, it)) } }.padding(vertical = 6.dp)
        .testTag("task-run:${run.text("id")}"), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        if (state == "RUNNING") CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp) else Box(Modifier.size(8.dp).background(color, CircleShape))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row {
                Text(run.obj("agent")?.text("name") ?: run.text("title") ?: TaskDetailCopy.untitledSession, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                run.text("createdAt")?.let { created -> (if (state == "RUNNING") TaskTime.elapsed(created) else TaskTime.relative(created))?.let {
                    Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) } }
            }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(TaskDetailLogic.runLabel(run), style = MaterialTheme.typography.bodySmall, color = color)
                TaskDetailLogic.runModelLine(run, smartSelection, name)?.let { Text("· $it", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false)) }
                if (route?.flag("applied") == true) Text(TaskDetailLogic.routeTierTag(route), style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold,
                    color = if (route.flag("escalated")) LocalOrbitColors.current.needsYou else LocalOrbitColors.current.running)
            }
            if (route != null && !route.flag("applied")) Text(TaskDetailCopy.wouldHavePicked(TaskDetailLogic.routePick(route, name), route.text("level").orEmpty()),
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.tertiary)
        }
        if (route != null) TextButton(onClick = why, modifier = Modifier.semantics { contentDescription = TaskDetailCopy.why(TaskDetailLogic.routePick(route, name)) }) { Text("ⓘ") }
        Text("›", color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
internal fun Avatar(name: String?) {
    Text((name ?: "?").take(1).uppercase(), Modifier.size(20.dp).background(MaterialTheme.colorScheme.primary.copy(alpha = 0.14f), CircleShape)
        .padding(top = 1.dp), style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.primary,
        textAlign = androidx.compose.ui.text.style.TextAlign.Center)
}

/** A description or a comment: whole when short, folded with Show more when not (`TaskDetailLogic.folds`). */
@Composable
internal fun FoldableMarkdown(source: String, link: (String) -> Unit, folded: Dp = 300.dp, folds: Boolean = TaskDetailLogic.folds(source)) {
    var open by rememberSaveable(source) { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Box(Modifier.then(if (folds && !open) Modifier.heightIn(max = folded).clipToBounds() else Modifier)) { MarkdownText(source, open = link) }
        if (folds) TextButton(onClick = { open = !open }) { Text(if (open) TaskDetailCopy.showLess else TaskDetailCopy.showMore, fontWeight = FontWeight.SemiBold) }
    }
}
