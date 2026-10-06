package io.orbitd.android.tasks

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import io.orbitd.android.OrbitApplication
import io.orbitd.android.cards.BusinessCard
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.cards.*
import io.orbitd.android.core.net.*
import io.orbitd.android.core.realtime.SessionSnapshot
import io.orbitd.android.navigation.*
import io.orbitd.android.text.*
import io.orbitd.android.attachments.AttachmentActions
import io.orbitd.android.projects.ProjectGraph
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*
import java.util.UUID

@Composable
internal fun TaskDetail(app: OrbitApplication, handle: SessionHandle, id: String, revision: Long, open: (OrbitRoute) -> Unit) {
    val api = remember(handle, id) { TaskApi(app.session, handle) }
    val scope = rememberCoroutineScope()
    val live by app.realtime.state.collectAsState()
    val clipboard = LocalClipboardManager.current
    var task by remember(handle, id) { mutableStateOf<JsonObject?>(null) }
    var row by remember(handle, id) { mutableStateOf<JsonObject?>(null) }
    var showGraph by rememberSaveable(id) { mutableStateOf(true) }
    var graph by remember(handle, id) { mutableStateOf<JsonObject?>(null) }
    var owner by remember(handle, id) { mutableStateOf<JsonObject?>(null) }
    var attribution by remember(handle, id) { mutableStateOf<JsonObject?>(null) }
    var lists by remember(handle, id) { mutableStateOf<List<JsonObject>>(emptyList()) }
    var watches by remember(handle, id) { mutableStateOf<List<JsonObject>>(emptyList()) }
    var error by remember(handle, id) { mutableStateOf<String?>(null) }
    var readWarnings by remember(handle, id) { mutableStateOf<List<String>>(emptyList()) }
    var notice by remember(handle, id) { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(true) }
    var writing by remember { mutableStateOf(false) }
    var refresh by remember { mutableIntStateOf(0) }
    var comment by rememberSaveable(id) { mutableStateOf("") }
    var editor by remember { mutableStateOf<String?>(null) }
    var confirmation by remember { mutableStateOf<Pair<String, suspend () -> Unit>?>(null) }
    var input by remember { mutableStateOf<JsonObject?>(null) }
    var conflictingSession by remember { mutableStateOf<String?>(null) }
    val workspaces = live.directory?.workspaces.orEmpty()
    val resources = LocalReaderResources.current ?: remember(handle) { ReaderResources(app.session, handle) }
    val link = rememberReaderLinkHandler(resources, open)
    LaunchedEffect(handle, id, revision, refresh) {
        loading = true; error = null; readWarnings = emptyList(); owner = null; row = null; graph = null; attribution = null; watches = emptyList()
        try {
            task = api.detail(id)
            api.authorityRevision = task?.text("updatedAt").orEmpty()
            suspend fun optional(label: String, path: List<String>): JsonElement? = try { api.read(path) }
                catch (cancel: CancellationException) { throw cancel }
                catch (failure: Exception) {
                    if (failure is ApiError && failure.status in setOf(401, 403)) throw failure
                    readWarnings = readWarnings + "$label: ${taskError(failure)}"; null
                }
            coroutineScope {
                val liveRow = async { optional("Run availability", listOf("tasks", id, "row")) }
                val dependencyGraph = async { optional("Dependencies", listOf("tasks", id, "dependency-graph")) }
                val confirmationRead = async { optional("Owner confirmation", listOf("tasks", id, "owner-confirmation")) }
                val attributionRead = async { optional("Attribution", listOf("tasks", id, "attribution")) }
                val listRead = async { optional("Lists", listOf("task-lists")) }
                val watchRead = async { optional("Following", listOf("watches")) }
                row = liveRow.await() as? JsonObject; graph = dependencyGraph.await() as? JsonObject
                owner = confirmationRead.await() as? JsonObject; attribution = attributionRead.await() as? JsonObject
                lists = (listRead.await() as? JsonArray).orEmpty().filterIsInstance<JsonObject>()
                watches = (watchRead.await() as? JsonArray).orEmpty().filterIsInstance<JsonObject>().filter { watch ->
                    watch.objects("targets").any { it.text("targetKind") == "TASK" && ObjectId.same(it.text("targetResourceId"), id) }
                }
            }
        } catch (cancel: CancellationException) { throw cancel }
        catch (failure: Exception) { task = null; error = taskError(failure) }
        finally { loading = false }
    }
    fun mutate(operation: suspend () -> Unit) {
        if (writing || loading || task == null || live.handle !== handle || !live.directoryFresh) return
        writing = true; notice = null; conflictingSession = null
        scope.launch {
            try { operation(); notice = "Saved. Reading current state…" }
            catch (cancel: CancellationException) { throw cancel }
            catch (failure: Exception) {
                notice = taskError(failure)
                conflictingSession = ((failure as? ApiError)?.body as? JsonObject)?.text("conflictingSessionId")
            }
            finally { writing = false; refresh++; app.realtime.refreshDirectory(); app.realtime.refreshSession() }
        }
    }
    fun patch(fields: JsonObject) = mutate { api.update(id, fields) }
    val enabled = !loading && !writing && task != null && live.handle === handle && live.directoryFresh
    val current = task
    LazyColumn(Modifier.fillMaxSize().testTag("task-detail"), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item {
            Text(current?.text("title") ?: "Task", style = MaterialTheme.typography.headlineMedium)
            TextButton(onClick = { refresh++ }, enabled = !writing) { Text("Refresh") }
            if (!live.directoryFresh) Text("Reconnecting · actions are unavailable until Orbit is checked.", style = MaterialTheme.typography.bodySmall)
            if (loading || writing) LinearProgressIndicator(Modifier.fillMaxWidth())
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            notice?.let { Text(it, Modifier.testTag("task-result")) }
            conflictingSession?.let { session -> TextButton(onClick = { open(OrbitRoute(Destination.SESSION, session)) }) { Text("Open the existing run") } }
            readWarnings.forEach { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error) }
        }
        if (current != null) {
            item {
                Text(listOfNotNull(taskStatus(row ?: current), taskPhrase(row ?: current)).joinToString(" · "))
                current.obj("project")?.let { project -> TextButton(onClick = { open(OrbitRoute(Destination.PROJECT, project.text("id"))) }) { Text("Project: ${project.text("title")}") } }
                current.text("terminalReason")?.let { Text("This attempt ended: ${it.lowercase().replace('_', ' ')}") }
                current.objects("successorChain").forEach { next -> TextButton(onClick = { open(OrbitRoute(Destination.TASK, next.text("id"))) }) { Text("Next attempt: ${next.text("title")}") } }
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = { mutate { api.execute(id, UUID.randomUUID().toString()) } }, modifier = Modifier.testTag("task-run"), enabled = enabled && row?.flag("runnable") == true) { Text(if (current.text("status") == "FAILED") "Retry task" else "Run now") }
                    if (row?.flag("running") == true || row?.flag("queued") == true) OutlinedButton(onClick = {
                        confirmation = "Stop this task's current runs?" to { api.batch("stop", listOf(id)) }
                    }, enabled = enabled) { Text("Stop") }
                    if (current.text("status") in setOf("DONE", "CANCELLED", "FAILED")) OutlinedButton(onClick = {
                        confirmation = "Reopen this task? Its history, evidence and dependencies stay in place. A superseded or dropped attempt becomes active again; project completion may change." to { api.reopen(id) }
                    }, enabled = enabled) { Text("Reopen task") }
                    if (owner?.let(TaskApi::canConfirmWithoutRun) == true) Button(onClick = {
                        confirmation = "Confirm this task is done? Orbit checks its completion criterion and waiting runs again." to { api.confirmWithoutRun(id) }
                    }, enabled = enabled) { Text("Confirm done") }
                }
                if (row?.flag("runnable") != true) Text("A new run requires an available assignee and satisfied server run conditions.", style = MaterialTheme.typography.bodySmall)
                owner?.obj("waiting")?.let { waiting ->
                    val sessionId = waiting.text("sessionId")
                    val cards = if (sessionId == null) emptyList() else CardCatalog.session(sessionId, SessionSnapshot(
                        buildJsonObject { put("id", sessionId); current.text("projectId")?.let { put("projectId", it) } },
                        emptyList(), emptyList(), emptyList(), mapOf("ownerConfirmation" to owner!!)))
                    cards.filter { it.family == CardFamily.OWNER_CONFIRMATION }.forEach { card ->
                        BusinessCard(card.copy(actions = emptyList()), fresh = false, open = link, submit = { _, _ -> })
                    }
                    if (sessionId != null) Button(onClick = { open(OrbitRoute(Destination.SESSION, sessionId)) }, enabled = enabled) {
                        Text(if (waiting.obj("review")?.text("state") == "UNDER_REVIEW") "Open review in run" else "Open confirmation in run")
                    }
                }
                Row(Modifier.horizontalScroll(rememberScrollState())) {
                    TextButton(onClick = { clipboard.setText(AnnotatedString("${handle.account.server}/tasks/$id")) }) { Text("Copy link") }
                    TextButton(onClick = { clipboard.setText(AnnotatedString("# ${current.text("title")}\n\n${current.text("description").orEmpty()}\n\n${handle.account.server}/tasks/$id")) }) { Text("Copy Markdown") }
                    TextButton(onClick = { editor = "share" }, enabled = enabled) { Text("Share…") }
                    TextButton(onClick = { editor = "follow" }, enabled = enabled) { Text("Follow task") }
                    TextButton(onClick = { confirmation = "Delete this task? This cannot be undone. Finished run sessions remain; active runs stop." to {
                        api.write(listOf("tasks", id), HttpMethod.DELETE); open(OrbitRoute(Destination.TASKS))
                    } }, enabled = enabled) { Text("Delete") }
                }
            }
            current.obj("verifier")?.let { verifier -> item {
                TaskSection("Completion check") { TextButton(onClick = { open(OrbitRoute(Destination.TASK, verifier.text("id"))) }) { Text(verifier.text("title") ?: "Open verifier") } }
            } }
            item { TaskSection("Details") {
                TaskChoice("Assignee", listOf(null to "Unassigned") + workspaces.map { it.text("id") to (it.text("name") ?: "Workspace") }, current.text("assigneeId"), enabled) {
                    patch(buildJsonObject { put("assigneeId", it?.let(::JsonPrimitive) ?: JsonNull) })
                }
                TaskChoice("List", listOf(null to "No list") + lists.map { it.text("id") to (it.text("title") ?: "List") }, current.text("listId"), enabled) {
                    patch(buildJsonObject { put("listId", it?.let(::JsonPrimitive) ?: JsonNull) })
                }
                TaskChoice("Suggested model", listOf(null to "No suggestion") + current.objects("modelHintOptions").map {
                    it.text("level") to listOfNotNull(it.text("level"), it.text("label") ?: it.text("model"), it.text("effort")).joinToString(" · ")
                }, current.text("modelHint"), enabled) { patch(buildJsonObject { put("modelHint", it?.let(::JsonPrimitive) ?: JsonNull); put("modelHintReason", JsonNull) }) }
                current.text("modelHintReason")?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                Text("Provider: ${current.text("provider") ?: "Inherited"} · Model: ${current.text("model") ?: "Inherited"}")
                TextButton(onClick = { editor = "model" }, enabled = enabled) { Text("Provider and model…") }
                Text("Starts: ${current.text("runAt") ?: "Not scheduled"}")
                TextButton(onClick = { editor = "schedule" }, modifier = Modifier.testTag("task-plan"), enabled = enabled) { Text("Schedule…") }
                current.obj("creatorSession")?.let { creator -> TextButton(onClick = { open(OrbitRoute(Destination.SESSION, creator.text("id"))) }) { Text("Created from ${creator.text("title") ?: "session"}") } }
                Text(listOfNotNull(current.text("creatorName"), current.text("createdAt")).joinToString(" · "), style = MaterialTheme.typography.bodySmall)
            } }
            item { TaskSection("Dependencies") {
                if (current.objects("dependsOn").isEmpty()) Text("No prerequisites")
                current.objects("dependsOn").forEach { edge -> edge.obj("dependsOnTask")?.let { prerequisite ->
                    Row { TextButton(onClick = { open(OrbitRoute(Destination.TASK, prerequisite.text("id"))) }, Modifier.weight(1f)) { Text("${prerequisite.text("title")} · ${taskStatus(prerequisite)}") }
                        TextButton(onClick = { confirmation = "Remove this prerequisite?" to { api.removeDependency(id, prerequisite.text("id")!!) } }, enabled = enabled) { Text("Remove") }
                    }
                } }
                graph?.let { value ->
                    Row {
                        FilterChip(showGraph, { showGraph = true }, label = { Text("Graph") })
                        Spacer(Modifier.width(8.dp))
                        FilterChip(!showGraph, { showGraph = false }, label = { Text("List") })
                    }
                    if (showGraph) ProjectGraph(taskGraphForDisplay(value)) { open(OrbitRoute(Destination.TASK, it)) }
                    else {
                    value.objects("edges").forEach { edge ->
                        val nodes = value.objects("nodes").associateBy { it.text("id") }
                        val source = nodes[edge.text("sourceTaskId")]; val target = nodes[edge.text("targetTaskId")]
                        Text("${source?.text("title") ?: edge.text("sourceTaskId")} → ${target?.text("title") ?: edge.text("targetTaskId")}", style = MaterialTheme.typography.bodySmall)
                    }
                    value.objects("nodes").filter { !ObjectId.same(it.text("id"), id) }.forEach { node ->
                        TextButton(onClick = { open(OrbitRoute(Destination.TASK, node.text("id"))) }) { Text("${node.text("title")} · ${taskStatus(node)}") }
                    }
                    }
                    if (value.flag("truncated") || value.flag("truncatedEdges")) Text("Showing a limited dependency graph. Open a related task to continue.")
                }
                if (current.objects("dependsOn").isNotEmpty()) Row {
                    Switch(current["autoRunWhenReady"] != JsonPrimitive(false), { patch(buildJsonObject { put("autoRunWhenReady", it) }) }, enabled = enabled)
                    Text("Run automatically when prerequisites are ready", Modifier.padding(12.dp))
                }
                TextButton(onClick = { editor = "dependency" }, modifier = Modifier.testTag("task-dependencies"), enabled = enabled) { Text("Add prerequisite") }
            } }
            current.text("description")?.takeIf { it.isNotBlank() }?.let { description -> item { TaskSection("Description") { MarkdownText(description, open = link) } } }
            item { TaskSection("Acceptance") {
                Text("Completion criterion: ${current.text("completionCriterion") ?: "Not provided"}")
                current.text("acceptanceCriteria")?.let { MarkdownText(it, open = link) } ?: Text("No acceptance description")
                current.text("acceptanceCommand")?.let { Text(it); Text("Done when it exits ${current.number("acceptanceExpectedExitCode")}") }
                TextButton(onClick = { editor = "acceptance" }, modifier = Modifier.testTag("task-edit"), enabled = enabled) { Text("Edit acceptance") }
            } }
            item { TaskSection("Inputs") {
                Text("Files supplied to every run of this task", style = MaterialTheme.typography.bodySmall)
                if (current.objects("attachments").isEmpty()) Text("No inputs")
                current.objects("attachments").forEach { attachment ->
                    Row { TextButton(onClick = { input = attachment }, Modifier.weight(1f)) { Text(attachment.text("fileName") ?: attachment.text("mimeType") ?: "Attachment") }
                        TextButton(onClick = { confirmation = "Remove this input from future runs?" to { api.write(listOf("attachments", attachment.text("id")!!), HttpMethod.DELETE) } }, enabled = enabled) { Text("Remove") }
                    }
                }
                TaskInputUpload(app, handle, id, enabled, api.authorityRevision, onResult = { notice = it; refresh++ })
            } }
            attribution?.let { value -> item { TaskSection("Attribution") { TaskAttribution(value, open) } } }
            item { TaskSection("Following") {
                if (watches.isEmpty()) Text("No watches shown for this task")
                watches.forEach { watch -> TextButton(onClick = { open(OrbitRoute(Destination.WATCH, watch.text("id"))) }) { Text("${watch.text("state")} · ${watch.obj("predicate")?.text("leaf")?.lowercase()?.replace('_', ' ')}") } }
            } }
            item { Text("Runs", style = MaterialTheme.typography.titleLarge) }
            if (current.objects("sessions").isEmpty()) item { Text("No runs yet") }
            items(current.objects("sessions"), key = { "run:${it.text("id")}" }) { run ->
                OutlinedCard(onClick = { open(OrbitRoute(Destination.SESSION, run.text("id"))) }, Modifier.fillMaxWidth()) { Column(Modifier.padding(12.dp)) {
                    Text(run.text("title") ?: "Open run", style = MaterialTheme.typography.titleMedium)
                    Text(listOfNotNull(run.text("runState") ?: run.text("status"), run.text("model"), run.text("effort"), run.text("createdAt")).joinToString(" · "))
                    run.obj("route")?.let { route ->
                        Text(if (route.flag("applied")) "Model selection applied" else "Suggested model selection")
                        route.strings("reasons").forEach { Text(it, style = MaterialTheme.typography.bodySmall) }
                        Text("Policy ${route.number("policyVersion")} · ${route.text("decidedAt").orEmpty()}", style = MaterialTheme.typography.labelSmall)
                    }
                } }
            }
            item { Text("Comments", style = MaterialTheme.typography.titleLarge) }
            items(current.objects("comments"), key = { "comment:${it.text("id")}" }) { entry ->
                Column {
                    Text(listOfNotNull(entry.text("authorName"), entry.text("createdAt")).joinToString(" · "), style = MaterialTheme.typography.labelSmall)
                    MarkdownText(entry.text("body").orEmpty(), open = link)
                }
            }
            item {
                OutlinedTextField(comment, { comment = it }, Modifier.fillMaxWidth().testTag("task-comment"), label = { Text("Add a comment") }, minLines = 2)
                Button(onClick = { mutate { api.addComment(id, comment); comment = "" } }, modifier = Modifier.testTag("task-post-comment"), enabled = enabled && comment.isNotBlank()) { Text("Post comment") }
            }
        }
    }
    confirmation?.let { (message, operation) -> AlertDialog(onDismissRequest = { confirmation = null }, title = { Text("Confirm change") }, text = { Text(message) },
        confirmButton = { TextButton(onClick = { confirmation = null; mutate(operation) }, enabled = enabled) { Text("Confirm") } },
        dismissButton = { TextButton(onClick = { confirmation = null }) { Text("Cancel") } }) }
    input?.let { attachment -> AttachmentActions(attachment.text("fileName") ?: "attachment", attachment.text("mimeType") ?: "application/octet-stream",
        bytes = { app.session.request(handle, ApiRequest(listOf("attachments", attachment.text("id")!!), maxResponseBytes = 25L * 1024 * 1024)).body }, close = { input = null }) }
    if (current != null) editor?.let { kind ->
        TaskEditor(kind, current, api, enabled, workspaces, close = { editor = null }, submit = { fields -> editor = null; patch(fields) },
            operation = { block -> editor = null; mutate(block) }, open = open)
    }
}

@Composable
internal fun TaskSection(title: String, content: @Composable ColumnScope.() -> Unit) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        HorizontalDivider(); Text(title, style = MaterialTheme.typography.titleLarge); content()
    }
}

@Composable
private fun TaskAttribution(value: JsonObject, open: (OrbitRoute) -> Unit) {
    value.obj("owning")?.let { project -> TextButton(onClick = { open(OrbitRoute(Destination.PROJECT, project.text("projectId"))) }) { Text("Counts toward ${project.text("title")}") } }
        ?: Text(value.text("owningAbsentReason")?.replace('_', ' ') ?: "No owning project recorded")
    value.obj("discovery")?.let { discovery ->
        Text(discovery.text("triggerEvent") ?: discovery.text("absentReason") ?: "Discovery recorded", style = MaterialTheme.typography.bodySmall)
        discovery.obj("task")?.let { task -> TextButton(onClick = { open(OrbitRoute(Destination.TASK, task.text("taskId"))) }) { Text("Found in ${task.text("title")}") } }
        discovery.obj("session")?.let { session -> TextButton(onClick = { open(OrbitRoute(Destination.SESSION, session.text("sessionId"))) }) { Text("Discovery session: ${session.text("title") ?: "Open"}") } }
    }
    value.obj("blocker")?.let { blocker -> Text(listOfNotNull(blocker.text("kind"), blocker.text("owner"), blocker.text("requiredAction"), blocker.text("nextCheckAt")).joinToString(" · ")) }
        ?: value.text("blockerAbsentReason")?.let { Text(it.replace('_', ' '), style = MaterialTheme.typography.bodySmall) }
    value.obj("crossing")?.let { crossing ->
        Text("${crossing.text("state")}: ${crossing.obj("from")?.text("title") ?: "No project"} → ${crossing.obj("to")?.text("title") ?: "No project"}")
        crossing.text("requiredAction")?.let { Text(it) }
    } ?: value.text("crossingAbsentReason")?.let { Text(it.replace('_', ' '), style = MaterialTheme.typography.bodySmall) }
}
