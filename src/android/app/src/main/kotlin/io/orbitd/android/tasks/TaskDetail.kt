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
import io.orbitd.android.attachments.AttachmentActions
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.cards.*
import io.orbitd.android.core.net.ApiError
import io.orbitd.android.core.net.ApiRequest
import io.orbitd.android.directory.orderedWorkspaceRows
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
    var graph by mutableStateOf<JsonObject?>(null)
    var watches by mutableStateOf<List<JsonObject>?>(null)
    var watchesFailed by mutableStateOf(false)
    var lists by mutableStateOf<List<JsonObject>>(emptyList())
    var share by mutableStateOf<JsonObject?>(null)
    var runner by mutableStateOf<JsonObject?>(null)
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
                val watches = async { runCatching { api.watches() } }
                val lists = async { runCatching { api.lists() }.getOrNull() }
                val share = async { runCatching { api.share(id) }.getOrNull() }
                val runnerId = workspaces.firstOrNull { ObjectId.same(it.text("id"), task.obj("assignee")?.text("id")) }?.text("runnerId")
                val runner = async { runnerId?.let { runCatching { api.read(listOf("runners", it)) as? JsonObject }.getOrNull() } }
                val providers = async { runCatching { (api.read(listOf("providers")) as? JsonArray).orEmpty().filterIsInstance<JsonObject>() }.getOrNull() }
                data.owner = owner.await()
                attribution.await().onSuccess { data.attribution = it; data.attributionFailed = false }.onFailure { if (data.attribution == null) data.attributionFailed = true }
                graph.await()?.let { data.graph = it }
                watches.await().onSuccess { data.watches = it; data.watchesFailed = false }.onFailure { data.watchesFailed = true }
                lists.await()?.let { data.lists = it }
                share.await()?.let { data.share = it }
                runner.await()?.let { data.runner = it }
                providers.await()?.let { data.providers = it }
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
    LaunchedEffect(data.notice) { if (data.notice != null) { delay(3000); data.notice = null } }

    /** A write belongs to the app, not to this page (iOS's model-owned Task): leaving does not cancel it,
     * so a Run's resends and a comment still go out. A sheet that sent it closes only once it is taken, and its
     * answer is that sheet's alone — shown under it, or on the page's banner once it (or the page) is gone. */
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
                data.busy = false
                app.realtime.refreshDirectory()
                if (data.attached) load()
            }
        }
    }
    fun revisionOf(task: JsonObject) = "${task.text("id")}:${task.text("updatedAt")}"
    fun patch(fields: JsonObject, saved: String? = null, fromSheet: String? = null, done: () -> Unit = {}) { val task = data.task ?: return
        mutate(fromSheet, done) { api.update(id, fields, revisionOf(task) + ":" + fields); saved?.let { data.notice = it } } }
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
    val row = TaskDetailLogic.actionRow(OwnerConfirmations.panelAction(data.owner?.takeIf { ObjectId.same(it.text("taskId"), id) }, task),
        TaskReopen.isOffered(task), task.text("status"), TaskJudgment.isGateRow(task), TaskRunHandoff.entry(task))
    val graph = TaskDetailLogic.dependencyGraph(task, data.graph)
    val webUrl = "${handle.account.server.trimEnd('/')}/tasks/${task.text("id") ?: id}"

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
                                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                            SelectionContainer { Text(task.text("title") ?: "Untitled task", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold) }
                        }
                        Box {
                            TextButton(onClick = { menu = true }, modifier = Modifier.testTag("task-menu").semantics { contentDescription = "Task actions" }) { Text("⋯", style = MaterialTheme.typography.titleLarge) }
                            DropdownMenu(menu, { menu = false }) {
                                DropdownMenuItem(text = { Text(SharePanelCopy.copyLink) }, onClick = { menu = false; clipboard.setText(AnnotatedString(webUrl)); data.notice = SharePanelCopy.linkCopied })
                                DropdownMenuItem(text = { Column { Text(SharePanelCopy.share); SharePanel.menuStatus(data.share)?.let { Text(it, style = MaterialTheme.typography.bodySmall) } } },
                                    enabled = enabled, onClick = { menu = false; sheet = "share" })
                                DropdownMenuItem(text = { Text(SharePanelCopy.copyAsMarkdown) }, onClick = {
                                    menu = false
                                    clipboard.setText(AnnotatedString(TaskMarkdown.task(task, webUrl) { iso -> TaskTime.local(iso) ?: "—" }))
                                    data.notice = SharePanelCopy.markdownCopied
                                })
                                HorizontalDivider()
                                DropdownMenuItem(text = { Text(TaskDetailCopy.deleteTask, color = MaterialTheme.colorScheme.error) }, enabled = enabled,
                                    onClick = { menu = false; confirm = DetailConfirm.Delete })
                            }
                        }
                    }
                    // Wraps rather than squeezing a word to a letter a line under a large font.
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        TaskStatusPill(TaskListLogic.pill(task))
                        task.obj("assignee")?.let { assignee -> Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Avatar(assignee.text("name")); Text(assignee.text("name") ?: TaskListCopy.unassigned, maxLines = 1, style = MaterialTheme.typography.bodySmall) } }
                        task.text("createdAt")?.let(TaskTime::relative)?.let { Text("· $it", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    }
                    TaskJudgment.chip(task)?.let { chip ->
                        Text("${if (chip.isGate) "◈" else "✓"} ${chip.text}", Modifier.testTag("task-judgment").background(
                            if (chip.isGate) LocalOrbitColors.current.needsYou.copy(alpha = 0.1f) else MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(50))
                            .padding(horizontal = 8.dp, vertical = 3.dp), style = MaterialTheme.typography.labelMedium,
                            color = if (chip.isGate) LocalOrbitColors.current.needsYou else MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    if (!connected) OfflineNote()
                    data.loadError?.let { TaskErrorBanner(it, retry = { scope.launch { load() } }) { data.loadError = null } }
                    data.error?.let { TaskErrorBanner(it) { data.error = null } }
                    data.notice?.let { Text(it, Modifier.testTag("task-notice"), style = MaterialTheme.typography.bodySmall, color = LocalOrbitColors.current.success) }
                    data.conflict?.let { conflict -> TaskRunConflictCard(conflict, { open(OrbitRoute(Destination.SESSION, it)) },
                        conflict.taskId?.let { { patch(buildJsonObject { put("provider", JsonNull); put("model", JsonNull) }) } }) { data.conflict = null } }
                    ActionRow(row, canStart, enabled, task, assigneeHasRunner, open, run = {
                        val trigger = UUID.randomUUID().toString()
                        mutate { api.execute(id, trigger, revisionOf(task)) }
                    }, confirmDone = { mutate { api.confirmOwner(id, revisionOf(task)) } }, reopen = { confirm = DetailConfirm.Reopen })
                }
            }
            if (TaskJudgment.isGateRow(task) || task.obj("verifier") != null) item(key = "verifier") {
                TaskSectionHeader(TaskJudgmentCopy.verifierCardHeading)
                val verifier = task.obj("verifier")
                if (verifier == null) Text(TaskJudgmentCopy.verificationSubjectHint.getValue("MISSING"), style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)
                else Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(verifier.text("title") ?: "Untitled task", Modifier.weight(1f), maxLines = 2)
                    TaskStatusPill(TaskJudgment.verifierPill(verifier))
                    OutlinedButton(onClick = { verifier.text("id")?.let { open(OrbitRoute(Destination.TASK, it)) } }) { Text(TaskJudgmentCopy.verifierCardEntry) }
                }
            }
            item(key = "details") { DetailsSection(task, data, workspaces, assigneeWorkspace, enabled, open, edit = { sheet = it }) { fields -> patch(fields) } }
            item(key = "dependencies") {
                TaskSectionHeader(TaskDetailCopy.dependenciesHeading)
                Column(Modifier.testTag("task-dependencies-section"), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    TaskDetailLogic.dependencySummary(task, graph)?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    TaskDetailLogic.blockedNotice(task)?.let { (text, failed) -> Text("🔒 $text", style = MaterialTheme.typography.bodySmall,
                        color = if (failed) MaterialTheme.colorScheme.error else LocalOrbitColors.current.needsYou) }
                    if (!TaskDetailLogic.hasDependencies(task)) Text(TaskDetailCopy.noDependencies, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    else {
                        val showGraph = (dependencyView ?: if (TaskDetailLogic.prefersGraph(graph)) "graph" else "list") == "graph"
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            FilterChip(showGraph, { dependencyView = "graph" }, label = { Text(TaskDetailCopy.graphView) })
                            FilterChip(!showGraph, { dependencyView = "list" }, label = { Text(TaskDetailCopy.listView) }, modifier = Modifier.testTag("task-dependency-list"))
                        }
                        if (showGraph) TaskDependencyGraphView(TaskDetailLogic.graphMarks(graph), graph.text("focusTaskId") ?: id) { open(OrbitRoute(Destination.TASK, it)) }
                        else TaskDetailLogic.dependencyRows(graph).forEach { dependency -> DependencyRowView(dependency, enabled, open) { confirm = DetailConfirm.RemovePrerequisite(dependency) } }
                        TaskDetailLogic.truncationNotice(graph)?.let { Text(it, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    }
                    if (task.objects("dependsOn").isNotEmpty()) Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(TaskDetailCopy.autoRunWhenReady, Modifier.weight(1f))
                        Switch(task["autoRunWhenReady"] != JsonPrimitive(false), { patch(buildJsonObject { put("autoRunWhenReady", it) }) }, enabled = enabled,
                            modifier = Modifier.testTag("task-auto-run"))
                    }
                    TextButton(onClick = { sheet = "dependency" }, enabled = enabled, modifier = Modifier.testTag("task-add-prerequisite")) { Text("＋ ${TaskDetailCopy.addPrerequisite}") }
                }
            }
            task.text("description")?.takeIf { it.isNotEmpty() }?.let { description -> item(key = "description") {
                TaskSectionHeader(TaskDetailCopy.descriptionHeading); FoldableMarkdown(description, link)
            } }
            item(key = "acceptance") {
                val draft = AcceptanceDraft(task)
                TaskSectionHeader(TaskDetailCopy.acceptanceHeading) { TextButton(onClick = { sheet = "acceptance" }, enabled = enabled, modifier = Modifier.testTag("task-edit-acceptance")) { Text(TaskDetailCopy.edit) } }
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(TaskDetailCopy.acceptanceCriteriaLabel, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    AcceptanceDraft.blankToNull(draft.criteria)?.let { FoldableMarkdown(it, link) } ?: Text(TaskDetailCopy.acceptanceEmpty, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(TaskDetailCopy.automaticJudgementLabel, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (draft.command.isNotBlank() && draft.exitCode.isNotBlank()) {
                        SelectionContainer { Text(draft.command.trim(), fontFamily = FontFamily.Monospace) }
                        Text("${TaskDetailCopy.doneWhenItExits} ${draft.exitCode.trim()}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    } else Text(TaskDetailCopy.acceptancePairEmpty)
                    Text(TaskDetailCopy.acceptanceAutomaticHint, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            item(key = "inputs") {
                val inputs = task.objects("attachments")
                TaskSectionHeader(TaskDetailCopy.inputsHeading, "${inputs.size}")
                Text(TaskDetailCopy.inputsHint, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                inputs.forEach { input ->
                    Row(Modifier.fillMaxWidth().clickable(role = Role.Button) { viewing = input }.padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Text(if (input.text("mimeType").orEmpty().startsWith("image/")) "🖼" else "📄")
                        Column(Modifier.weight(1f)) {
                            Text(input.text("fileName") ?: input.text("mimeType").orEmpty(), maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
                            Text(TaskDetailLogic.humanSize((input["sizeBytes"] as? JsonPrimitive)?.longOrNull ?: 0L), style = MaterialTheme.typography.labelMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        TextButton(onClick = { confirm = DetailConfirm.RemoveInput(input) }, enabled = enabled,
                            modifier = Modifier.semantics { contentDescription = "Remove input" }) { Text("✕") }
                    }
                }
                TaskInputUpload(app, handle, id, enabled) { message -> if (message != null) data.error = message; scope.launch { load() } }
            }
            item(key = "attribution") {
                TaskSectionHeader(TaskDetailCopy.attributionHeading)
                val view = data.attribution
                when {
                    view != null -> TaskDetailLogic.attributionRows(view).forEach { fact -> AttributionRowView(fact, open) }
                    data.attributionFailed -> Text("⚠ ${TaskDetailCopy.attributionUnavailable}", color = LocalOrbitColors.current.needsYou, style = MaterialTheme.typography.bodySmall)
                    else -> LinearProgressIndicator(Modifier.fillMaxWidth())
                }
            }
            item(key = "followed") {
                val (followers, ended) = TaskDetailLogic.followers(id, data.watches.orEmpty())
                TaskSectionHeader(TaskDetailCopy.followedByHeading, "${followers.size}")
                when {
                    data.watches == null && !data.watchesFailed -> Text(TaskDetailCopy.loadingWatches, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    data.watches == null -> Text(TaskDetailCopy.watchesUnavailable, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    followers.isEmpty() -> Text(TaskDetailCopy.nothingWatching, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    else -> followers.forEach { watch -> Column(Modifier.fillMaxWidth().clickable(role = Role.Button) {
                        watch.text("id")?.let { open(OrbitRoute(Destination.WATCH, it)) } }.padding(vertical = 6.dp)) {
                        Text(TaskFollow.condition(watch.obj("predicate")))
                        Text(listOf(if (watch.text("state") == "PAUSED") "Paused" else "Watching", "Notify you").joinToString(" · "),
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    } }
                }
                if (ended > 0) Text(TaskDetailCopy.endedWatches(ended), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                TextButton(onClick = { sheet = "follow" }, enabled = enabled, modifier = Modifier.testTag("task-follow")) { Text("👁 ${TaskDetailCopy.followTask}") }
            }
            item(key = "runs-head") { TaskSectionHeader(TaskDetailCopy.runsHeading, "${task.objects("sessions").size}") }
            if (task.objects("sessions").isEmpty()) item(key = "runs-empty") { Text(TaskDetailCopy.noRuns, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            items(task.objects("sessions"), key = { "run:${it.text("id")}" }) { run -> RunRow(run, task, data, open) { sheet = "why:${run.text("id")}" } }
            item(key = "comments-head") { TaskSectionHeader(TaskDetailCopy.commentsHeading, "${task.objects("comments").size}") }
            if (task.objects("comments").isEmpty()) item(key = "comments-empty") { Text(TaskDetailCopy.noComments, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            items(task.objects("comments"), key = { "comment:${it.text("id")}" }) { entry ->
                Column(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Avatar(entry.text("authorName"))
                        Text(entry.text("authorName") ?: "Unknown", style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold)
                        entry.text("createdAt")?.let(TaskTime::relative)?.let { Text("· $it", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                    }
                    FoldableMarkdown(entry.text("body").orEmpty(), link)
                }
            }
        }
        // The comment box stays on screen: asking an agent about this task is one tap away.
        Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 6.dp), verticalAlignment = Alignment.Bottom) {
            OutlinedTextField(comment, { TaskCommentDrafts[draft] = it }, Modifier.weight(1f).testTag("task-comment"),
                placeholder = { Text(TaskDetailCopy.commentPlaceholder, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                maxLines = 4, shape = RoundedCornerShape(22.dp))
            TextButton(onClick = {
                val body = comment.trim()
                if (body.isNotEmpty()) mutate {
                    api.addComment(id, body, mentionedWorkspaceIds(body, workspaces), revisionOf(task) + ":" + body)
                    TaskCommentDrafts.sent(draft, body)
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
            TaskDetailLogic.runRoute(run)?.let { route -> RouteWhySheet(route, { modelName(it, task, data) }) { sheet = null } }
        } ?: run { sheet = null }
    }
}

/** The two presses under the title, and the reason a run cannot start when it cannot. */
@Composable
private fun ActionRow(row: TaskActionRow, canStart: Boolean, enabled: Boolean, task: JsonObject, assigneeHasRunner: Boolean,
    open: (OrbitRoute) -> Unit, run: () -> Unit, confirmDone: () -> Unit, reopen: () -> Unit) {
    if (row.isEmpty) return
    val needsYou = LocalOrbitColors.current.needsYou
    val leading: (@Composable (Modifier) -> Unit)? = row.leading?.let { leading -> { modifier ->
        when (leading) {
            is TaskActionRow.Leading.Waiting -> Button(onClick = { open(OrbitRoute(Destination.SESSION, leading.sessionId)) }, modifier.testTag("task-owner-waiting"),
                colors = ButtonDefaults.buttonColors(containerColor = needsYou)) { Text(OwnerConfirmationCopy.waitingForConfirmation, maxLines = 1) }
            is TaskActionRow.Leading.UnderReview -> OutlinedButton(onClick = { open(OrbitRoute(Destination.SESSION, leading.sessionId)) }, modifier.testTag("task-owner-review")) {
                Text("◷ ${OwnerConfirmationCopy.underReview}", maxLines = 1) }
            TaskActionRow.Leading.ConfirmDone -> OutlinedButton(onClick = confirmDone, modifier.testTag("task-confirm-done"), enabled = enabled) { Text(OwnerConfirmationCopy.confirmAction, maxLines = 1) }
            TaskActionRow.Leading.Reopen -> OutlinedButton(onClick = reopen, modifier.testTag("task-reopen"), enabled = enabled) { Text(TaskReopenCopy.actionLabel, maxLines = 1) }
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
        if (trailingKind != null && trailingKind !is TaskActionRow.Trailing.OpenRun && !canStart)
            TaskDetailLogic.runDisabledHint(task, assigneeHasRunner)?.let { Text(it, Modifier.testTag("task-run-hint"), style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}

@Composable
private fun DetailsSection(task: JsonObject, data: TaskDetailData, workspaces: List<JsonObject>, assignee: JsonObject?, enabled: Boolean,
    open: (OrbitRoute) -> Unit, edit: (String) -> Unit, patch: (JsonObject) -> Unit) {
    TaskSectionHeader(TaskDetailCopy.detailsHeading)
    Column(Modifier.testTag("task-details"), verticalArrangement = Arrangement.spacedBy(2.dp)) {
        val currentAssignee = task.obj("assignee")
        PickerRow(TaskDetailCopy.assigneeLabel, currentAssignee?.text("name") ?: TaskListCopy.unassigned, enabled,
            listOf<Pair<String?, String>>(null to TaskListCopy.unassigned) + orderedWorkspaceRows(workspaces).map { it.text("id") to (it.text("name") ?: "Workspace") } +
                listOfNotNull(currentAssignee?.takeIf { a -> workspaces.none { ObjectId.same(it.text("id"), a.text("id")) } }?.let { it.text("id") to (it.text("name") ?: it.text("id").orEmpty()) }),
            tag = "task-assignee") { patch(buildJsonObject { put("assigneeId", it?.let(::JsonPrimitive) ?: JsonNull) }) }
        val picks = TaskDetailLogic.modelHintPicks(task.objects("modelHintOptions"))
        PickerRow(TaskDetailCopy.suggestedLabel, picks.firstOrNull { it.value == task.text("modelHint") }?.label ?: task.text("modelHint") ?: TaskDetailCopy.noSuggestion,
            enabled, picks.map { it.value to it.label }, details = picks.associate { it.value to it.detail }, tag = "task-suggested") { patch(TaskDetailLogic.modelHintRequest(it)) }
        val catalog = data.runner?.let { io.orbitd.android.composer.ComposerCatalog(it, data.providers) }
        val inherited = assignee?.text("provider") ?: assignee?.text("lastProvider")
        val providerOptions = catalog?.options(task.text("provider") ?: inherited ?: "claude", newSession = true).orEmpty()
        PickerRow(TaskDetailCopy.providerLabel, task.text("provider")?.let { p -> providerOptions.firstOrNull { it.id == p }?.label ?: p } ?: inherited?.let { "Assignee's ($it)" } ?: "Assignee's",
            enabled, listOf<Pair<String?, String>>(null to (inherited?.let { "Assignee's ($it)" } ?: "Assignee's")) + providerOptions.map { it.id to it.label } +
                listOfNotNull(task.text("provider")?.takeIf { p -> providerOptions.none { it.id == p } }?.let { it to it }), tag = "task-provider") {
            // A model id means something only inside one provider: changing the provider clears it.
            patch(buildJsonObject { put("provider", it?.let(::JsonPrimitive) ?: JsonNull); put("model", JsonNull) })
        }
        val effective = task.text("provider") ?: inherited ?: "claude"
        val models = catalog?.models(effective).orEmpty()
        val unpinned = if (assignee?.flag("modelRouting") == true) TaskDetailCopy.smartSelectionPlaceholder else "Provider default"
        PickerRow(TaskDetailCopy.modelLabel, task.text("model")?.let { m -> models.firstOrNull { it.text("value") == m }?.text("label") ?: m } ?: unpinned, enabled,
            listOf<Pair<String?, String>>(null to unpinned) + models.map { it.text("value") to (it.text("label") ?: it.text("value").orEmpty()) } +
                listOfNotNull(task.text("model")?.takeIf { m -> models.none { it.text("value") == m } }?.let { it to it }), tag = "task-model") {
            patch(buildJsonObject { put("model", it?.let(::JsonPrimitive) ?: JsonNull) })
        }
        PickerRow(TaskDetailCopy.listLabel, data.lists.firstOrNull { ObjectId.same(it.text("id"), task.text("listId")) }?.text("title")
            ?: task.text("listId")?.let { "Task List" } ?: TaskListCopy.noList, enabled,
            listOf<Pair<String?, String>>(null to TaskListCopy.noList) + data.lists.map { it.text("id") to (it.text("title") ?: "Task List") }, tag = "task-list") {
            patch(buildJsonObject { put("listId", it?.let(::JsonPrimitive) ?: JsonNull) })
        }
        DetailRow(TaskDetailCopy.startAtLabel, TaskDetailLogic.scheduleValue(task.text("runAt")), "⌄", enabled, "task-start-at") { edit("schedule") }
        task.obj("creatorSession")?.let { source -> DetailRow(TaskDetailCopy.createdFromLabel, source.text("title") ?: TaskDetailCopy.untitledSession, "›", true, "task-created-from") {
            source.text("id")?.let { open(OrbitRoute(Destination.SESSION, it)) } } }
        TaskDetailLogic.modelHintNote(task)?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        val creator = task.text("creatorName") ?: workspaces.firstOrNull { task.text("creatorType") == "AGENT" && ObjectId.same(it.text("id"), task.text("creatorId")) }?.text("name")
        TaskDetailLogic.createdFootnote(creator, task.text("createdAt"))?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}

/** A form row: the label, the value in grey with its chooser mark, and a menu of choices. */
@Composable
private fun PickerRow(label: String, value: String, enabled: Boolean, options: List<Pair<String?, String>>, details: Map<String?, String> = emptyMap(),
    tag: String, choose: (String?) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        DetailRow(label, value, "⇕", enabled, tag) { open = true }
        DropdownMenu(open, { open = false }) {
            options.distinctBy { it.first }.forEach { (option, title) -> DropdownMenuItem(text = { Column {
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
    val route = TaskDetailLogic.runRoute(run)
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
                TaskDetailLogic.runModelLine(run, name)?.let { Text("· $it", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
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
internal fun FoldableMarkdown(source: String, link: (String) -> Unit) {
    var open by rememberSaveable(source) { mutableStateOf(false) }
    val folds = TaskDetailLogic.folds(source)
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Box(Modifier.then(if (folds && !open) Modifier.heightIn(max = 300.dp) else Modifier)) { MarkdownText(source, open = link) }
        if (folds) TextButton(onClick = { open = !open }) { Text(if (open) TaskDetailCopy.showLess else TaskDetailCopy.showMore, fontWeight = FontWeight.SemiBold) }
    }
}
