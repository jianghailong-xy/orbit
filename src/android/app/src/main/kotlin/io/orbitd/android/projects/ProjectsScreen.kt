package io.orbitd.android.projects

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.cards.*
import io.orbitd.android.core.net.*
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.directory.DirectoryApi
import io.orbitd.android.directory.directoryError
import io.orbitd.android.navigation.*
import io.orbitd.android.taskprojects.FeatureWrites
import io.orbitd.android.text.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*
import java.util.UUID

private data class ProjectChange(val title: String, val detail: String, val request: ApiRequest,
    val reason: Boolean = false, val openSession: Boolean = false, val deleted: Boolean = false, val taskVersion: String? = null)
private fun projectRequest(path: List<String>, method: HttpMethod = HttpMethod.POST, body: JsonObject? = null) =
    ApiRequest(path, method, body = body?.toString()?.encodeToByteArray())

/** Projects retain the host's object stack, session identity and A04 invalidation stream. */
@Composable
fun ProjectsScreen(app: OrbitApplication, handle: SessionHandle, route: OrbitRoute,
    revision: Long, open: (OrbitRoute) -> Unit) {
    val directory = remember(handle) { DirectoryApi(app.session, handle) }
    val api = remember(handle) { ProjectsApi(directory) }
    val writes = remember(handle) { FeatureWrites(app.session, handle) }
    val scope = rememberCoroutineScope()
    val auth by app.session.state.collectAsState()
    val live by app.realtime.state.collectAsState()
    val clipboard = LocalClipboardManager.current
    var index by remember(handle, route.id) { mutableStateOf<List<JsonObject>>(emptyList()) }
    var page by remember(handle, route.id) { mutableStateOf<ProjectPageData?>(null) }
    var loading by remember(handle, route.id) { mutableStateOf(true) }
    var fresh by remember(handle, route.id) { mutableStateOf(false) }
    var error by remember(handle, route.id) { mutableStateOf<String?>(null) }
    var notice by remember(handle, route.id) { mutableStateOf<String?>(null) }
    var retry by remember(handle, route.id) { mutableIntStateOf(0) }
    var busy by remember(handle, route.id) { mutableStateOf(false) }
    var count by rememberSaveable(route.id) { mutableIntStateOf(100) }
    var query by rememberSaveable(route.id) { mutableStateOf("") }
    var completed by rememberSaveable(route.id) { mutableStateOf(false) }
    var change by remember(handle, route.id) { mutableStateOf<ProjectChange?>(null) }
    var settings by rememberSaveable(route.id) { mutableStateOf(false) }
    var sharing by rememberSaveable(route.id) { mutableStateOf(false) }
    var start by rememberSaveable(route.id) { mutableStateOf(false) }
    val signedIn = (auth as? AuthState.SignedIn)?.handle === handle
    val available = fresh && !loading && !busy && signedIn && live.handle === handle && live.directoryFresh
    val id = route.id
    fun refresh() { retry++; app.realtime.refreshDirectory() }
    LaunchedEffect(handle, id, revision, retry) {
        loading = true; fresh = false; error = null
        try {
            if (id == null) index = api.index() else page = api.page(id, count)
            fresh = true
        } catch (cancel: CancellationException) { throw cancel }
        catch (failure: Exception) {
            error = directoryError(failure)
            if (failure is ApiError && failure.status in setOf(401, 403, 404)) { page = null; index = emptyList(); change = null; settings = false; start = false; sharing = false }
        } finally { loading = false }
    }
    fun execute(action: ProjectChange, reason: String? = null) {
        if (!available || id == null) return
        val displayed = page ?: return
        busy = true
        scope.launch {
            try {
                val current = directory.objectRead(listOf("projects", id))
                check(listOf("configRevision", "updatedAt", "status", "startedAt", "pausedAt").all { current[it] == displayed.document[it] }) {
                    "This project changed. Review the refreshed details and try again."
                }
                val request = if (reason == null) action.request else ApiRequest(action.request.path, action.request.method, body = buildJsonObject { put("reason", reason.trim()) }.toString().encodeToByteArray())
                val identityBody = request.body?.let { Wire.json.parseToJsonElement(it.decodeToString()) as? JsonObject }?.let { JsonObject(it - "triggerId") }
                val version = action.taskVersion ?: "${displayed.document.text("configRevision")}:${displayed.document.text("updatedAt")}"
                val result = writes.execute("project:$id:$version:${request.method}:${request.path}:$identityBody", request)
                notice = "Request accepted. Checking the current server state."
                change = null; settings = false; start = false
                if (action.openSession) (result as? JsonObject)?.text("sessionId")?.let { open(OrbitRoute(Destination.SESSION, it)) }
                if (action.deleted) { page = null; open(OrbitRoute(Destination.PROJECTS)) }
            } catch (cancel: CancellationException) { throw cancel }
            catch (failure: Exception) {
                notice = if (failure is ApiError) listOfNotNull(failure.messages.firstOrNull(), failure.code).joinToString("\n").ifBlank { directoryError(failure) }
                    else failure.message ?: directoryError(failure)
                if (failure is ApiError && failure.status in setOf(401, 403, 404)) { page = null; change = null; settings = false; start = false; sharing = false }
            } finally { busy = false; fresh = false; refresh() }
        }
    }
    fun coordinator(replace: Boolean = false) {
        if (id == null) return
        val action = ProjectChange(if (replace) "Start a new coordinator conversation?" else "Open coordinator",
            "The current open conversation will be completed. The agent and workspace stay the same.",
            projectRequest(listOf("projects", id, "coordinator") + if (replace) listOf("replace") else emptyList()), openSession = true)
        if (replace) change = action else execute(action)
    }
    val displayedPage = page
    val enabled = available && (id == null || displayedPage?.document?.text("status") in setOf("OPEN", "DONE", "CANCELLED"))
    val resources = LocalReaderResources.current ?: remember(handle) { ReaderResources(app.session, handle) }
    val openText = rememberReaderLinkHandler(resources, open)
    LazyColumn(Modifier.fillMaxSize().testTag(if (id == null) "projects-list" else "project-detail"), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
        item {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Text(if (id == null) "Projects" else "Project", style = MaterialTheme.typography.headlineMedium)
                TextButton(onClick = { refresh() }, enabled = !loading && !busy) { Text("Refresh") }
            }
        }
        if (loading) item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
        error?.let { message -> item { Text(message, color = MaterialTheme.colorScheme.error); TextButton(onClick = { refresh() }) { Text("Retry") } } }
        notice?.let { message -> item { Text(message) } }
        if (!enabled && !loading && (displayedPage != null || index.isNotEmpty())) item {
            Text(if (busy) "Sending change…" else "Actions are unavailable until the current server state is checked.")
        }
        if (id == null) {
            item { OutlinedTextField(query, { query = it }, label = { Text("Search projects") }, modifier = Modifier.fillMaxWidth(), singleLine = true) }
            val matching = index.filter { "${it.text("title")} ${it.text("goal")}".contains(query.trim(), ignoreCase = true) }
            if (!loading && matching.isEmpty()) item {
                Text(if (query.isBlank()) "No projects yet. Ask an agent in a session to start a project." else "No matching projects.")
            }
            val now = java.time.Instant.now()
            ProjectAttention.lanes(matching, now).forEach { (lane, rows) ->
                if (rows.isNotEmpty()) {
                    item {
                        Row(verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                            Text("${lane.title} · ${rows.size}", style = MaterialTheme.typography.titleMedium)
                            if (lane == ProjectLane.COMPLETED && query.isBlank()) TextButton(onClick = { completed = !completed }) { Text(if (completed) "Hide" else "Show") }
                        }
                    }
                    if (lane != ProjectLane.COMPLETED || completed || query.isNotBlank()) items(rows, key = { it.text("id").orEmpty() }) { project ->
                        ProjectIndexRow(project) { project.text("id")?.let { open(OrbitRoute(Destination.PROJECT, it)) } }
                    }
                }
            }
        } else if (displayedPage != null) {
            val doc = displayedPage.document
            val sections = displayedPage.sections
            val coordinatorStatus = sections["coordinator"]
            val coordination = coordinatorStatus?.obj("coordination")
            val openability = coordinatorStatus?.obj("openability")
            val coordinatorId = coordination?.text("sessionId") ?: doc.text("coordinatorSessionId")
            val integration = sections["integration"]
            val openItems = sections["openItems"]
            item {
                Text(doc.text("title") ?: "Project", style = MaterialTheme.typography.headlineSmall)
                Text("${projectStatus(doc)} · ${doc.obj("_count")?.number("tasks") ?: 0} tasks")
                integration?.text("ref")?.let { Text("Tasks land on $it") }
                integration?.number("commitsAheadOfUpstream")?.let { Text("$it commits ahead of ${integration.text("upstreamRef") ?: "upstream"}") }
            }
            displayedPage.errors.forEach { (section, message) -> item { Text("${section.replaceFirstChar(Char::uppercase)}: $message", color = MaterialTheme.colorScheme.error) } }
            if (openItems != null) item {
                ProjectOpenItems(openItems, enabled, { coordinator() }, openText)
                if (doc.text("status") == "OPEN" && doc.containsKey("startedAt") && doc["startedAt"] == JsonNull && openItems.obj("startRequest") == null) {
                    TextButton(enabled = enabled && sections["confirmation"] != null && integration != null && sections["graph"] != null, onClick = { notice = null; start = true }) { Text("Start…") }
                }
            }
            sections["panorama"]?.let { panorama -> item { ProjectOverview(panorama, integration) } }
            item {
                Text("Coordinator", style = MaterialTheme.typography.titleLarge)
                Text(coordination?.obj("session")?.text("title") ?: coordinatorStatus?.text("state") ?: "Coordinator status unavailable")
                coordination?.text("workspaceName")?.let { Text(it) }
                coordination?.obj("session")?.text("runState")?.let { Text(it) }
                openability?.text("refusalDetail")?.let { Text(it) }
                openability?.text("requiredAction")?.let { Text(it) }
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    TextButton(modifier = Modifier.testTag("project-coordinator"), enabled = enabled && openability?.flag("canOpen") == true, onClick = { coordinator() }) { Text("Open coordinator") }
                    if (coordinatorId != null) TextButton(enabled = enabled && openability?.flag("canOpen") == true, onClick = { coordinator(true) }) { Text("New conversation") }
                }
            }
            if (!doc.containsKey("startedAt") || doc["startedAt"] != JsonNull) item {
                Text("How it runs", style = MaterialTheme.typography.titleLarge)
                Text("Automatic ${if (doc.flag("coordinatorEnabled")) "on" else "off"} · at most ${doc.number("maxConcurrentTasks") ?: 1} tasks")
                integration?.text("mergeCheckCommand")?.let { Text("Merge check: $it") }
                TextButton(enabled = enabled && integration != null && doc.text("configRevision") != null, onClick = { notice = null; settings = true }) { Text("Edit run settings") }
                val paused = doc.text("pausedAt") != null
                TextButton(enabled = enabled, onClick = { change = ProjectChange(if (paused) "Resume project" else "Pause project",
                    "Stops new tasks, wake-ups and merges into main. Running tasks finish.", projectRequest(listOf("projects", id, if (paused) "resume" else "pause"))) }) { Text(if (paused) "Resume project" else "Pause project") }
            }
            doc.text("goal")?.let { goal -> item { Text("Goal", style = MaterialTheme.typography.titleLarge); MarkdownText(goal, open = openText) } }
            sections["graph"]?.let { graph -> item { ProjectGraph(graph) { open(OrbitRoute(Destination.TASK, it)) } } }
            doc.obj("blockers")?.let { blockers ->
                item { Text("What's in the way", style = MaterialTheme.typography.titleLarge) }
                items(blockers.objects("open"), key = { "blocker:${it.text("id")}" }) { blocker ->
                    OutlinedCard(Modifier.fillMaxWidth()) { Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(blocker.text("subjectTitle") ?: blocker.text("kind") ?: "Blocker", style = MaterialTheme.typography.titleMedium)
                        Text("${blocker.text("owner")} · ${blocker.text("severity") ?: ""}")
                        Text(blocker.text("requiredAction").orEmpty())
                        blocker.text("criterionText")?.let { MarkdownText(it, open = openText) }
                        blocker.text("agentArgument")?.let { MarkdownText(it, open = openText) }
                        blocker.obj("detail")?.strings("paths")?.forEach { Text(it) }
                        if (blocker.text("owner") == "USER") TextButton(enabled = enabled, onClick = {
                            blocker.text("id")?.let { blockerId -> change = ProjectChange("Resolve blocker", "Your reason is recorded with your name. ${blocker.text("requiredAction").orEmpty()}",
                                projectRequest(listOf("projects", id, "blockers", blockerId, "resolve")), reason = true) }
                        }) { Text("Resolve…") }
                    } }
                }
                if (blockers.objects("open").isEmpty()) item { Text("No open blockers.") }
                items(blockers.objects("resolved"), key = { "resolved:${it.text("id")}" }) { blocker ->
                    Text("Resolved · ${blocker.text("subjectTitle") ?: blocker.text("kind")} · ${blocker.text("resolvedBy")}\n${blocker.text("resolutionNote").orEmpty()}")
                }
            }
            sections["ready"]?.let { ready ->
                item { Text("Ready to run", style = MaterialTheme.typography.titleLarge); Text("${ready.number("readyCount") ?: 0} ready · ${ready.number("runningCount") ?: 0} running · ${ready.number("queuedCount") ?: 0} queued") }
                items(ready.objects("items"), key = { "ready:${it.text("taskId")}" }) { task ->
                    Column {
                        TextButton(onClick = { task.text("taskId")?.let { open(OrbitRoute(Destination.TASK, it)) } }) { Text(task.text("title") ?: "Task") }
                        Text(task.text("runState") ?: "Unknown")
                        task.number("downstreamBlocked")?.let { Text("$it tasks depend on this work") }
                        if (task.text("runState") == "READY") TextButton(enabled = enabled, onClick = {
                            task.text("taskId")?.let { taskId -> execute(ProjectChange("Run task", "", projectRequest(listOf("tasks", taskId, "execute"), body = buildJsonObject { put("triggerId", UUID.randomUUID().toString()) }), taskVersion = task.toString())) }
                        }) { Text("Run") }
                        if (task.text("runState") == "PAUSED") task.obj("pausedList")?.let { list -> TextButton(enabled = enabled, onClick = {
                            list.text("id")?.let { listId -> change = ProjectChange("Resume ${list.text("title") ?: "task list"}?", "${list.number("readyCount") ?: 0} ready tasks will be released; ${list.number("autoRunReadyCount") ?: 0} can start automatically.",
                                projectRequest(listOf("task-lists", listId), HttpMethod.PATCH, buildJsonObject { put("paused", false); put("note", "Resumed from the project's ready queue.") })) }
                        }) { Text("Resume list…") } }
                        task.text("sessionId")?.let { session -> TextButton(onClick = { open(OrbitRoute(Destination.SESSION, session)) }) { Text("Open run") } }
                    }
                }
            }
            item { Text("Criteria", style = MaterialTheme.typography.titleLarge) }
            if (doc.objects("acceptanceCriteriaItems").isEmpty()) item { Text("No criteria stated yet.") }
            items(doc.objects("acceptanceCriteriaItems"), key = { "criterion:${it.text("id") ?: it.number("ordinal")}" }) { criterion ->
                var expanded by rememberSaveable(criterion.text("id")) { mutableStateOf(false) }
                OutlinedCard(Modifier.fillMaxWidth()) { Column(Modifier.padding(12.dp)) {
                    Text("${criterion.number("ordinal") ?: ""} · ${if (criterion.flag("satisfied")) "Satisfied" else "Not yet satisfied"} · ${criterion.text("landing") ?: "No landing receipt"}")
                    MarkdownText(criterion.text("text").orEmpty(), open = openText)
                    TextButton(onClick = { expanded = !expanded }) { Text(if (expanded) "Hide how it's checked" else "How it's checked") }
                    if (expanded) {
                        MarkdownText(criterion.text("verificationMethod") ?: "No verification method recorded.", open = openText)
                        criterion.objects("unmet").forEach { unmet ->
                            Text(unmet.text("clause").orEmpty())
                            unmet.objects("heldUpBy").forEach { held -> TextButton(onClick = { held.text("taskId")?.let { open(OrbitRoute(Destination.TASK, it)) } }) { Text("${held.text("title")} · ${held.text("requiredAction")}") } }
                        }
                    }
                } }
            }
            doc.text("instructions")?.let { instructions -> item { Text("Instructions", style = MaterialTheme.typography.titleLarge); MarkdownText(instructions, open = openText) } }
            item { Text("Tasks", style = MaterialTheme.typography.titleLarge) }
            if (displayedPage.tasks.isEmpty()) item { Text("No tasks yet.") }
            items(displayedPage.tasks, key = { "task:${it.text("id")}" }) { task ->
                ListItem(headlineContent = { Text(task.text("title") ?: "Task") }, supportingContent = {
                    Text(listOfNotNull(task.text("workState") ?: task.text("status"), task.obj("integration")?.text("state"),
                        "waits ${task.number("unmetCount") ?: 0} · blocks ${task.number("blocksCount") ?: 0}").joinToString(" · "))
                }, modifier = Modifier.clickable { task.text("id")?.let { open(OrbitRoute(Destination.TASK, it)) } })
            }
            if (displayedPage.nextCursor != null) item { TextButton(enabled = enabled, onClick = { count += 100; retry++ }) { Text("Load more tasks") } }
            item {
                Text("Project options", style = MaterialTheme.typography.titleLarge)
                if (doc.text("status") == "OPEN") {
                    TextButton(enabled = enabled, onClick = { change = ProjectChange("Record as done?", "${doc.objects("acceptanceCriteriaItems").count { it.flag("satisfied") }} of ${doc.objects("acceptanceCriteriaItems").size} criteria are satisfied. The server derives the resulting project state.",
                        projectRequest(listOf("projects", id), HttpMethod.PATCH, buildJsonObject { put("status", "DONE") })) }) { Text("Record as done…") }
                    TextButton(enabled = enabled, onClick = { change = ProjectChange("Record as cancelled?", "Unfinished tasks stay filed under it and won't start. A run already going is not stopped.",
                        projectRequest(listOf("projects", id), HttpMethod.PATCH, buildJsonObject { put("status", "CANCELLED") })) }) { Text("Record as cancelled…") }
                } else if (doc.text("status") in setOf("DONE", "CANCELLED")) TextButton(enabled = enabled, onClick = { change = ProjectChange("Reopen project?", "Tasks, stated criteria and history stay as they are.",
                    projectRequest(listOf("projects", id), HttpMethod.PATCH, buildJsonObject { put("status", "OPEN") })) }) { Text("Reopen project…") }
                TextButton(enabled = enabled && doc.obj("_count")?.number("tasks") == 0, onClick = { change = ProjectChange("Delete project?", "Only an empty project can be deleted.", projectRequest(listOf("projects", id), HttpMethod.DELETE), deleted = true) }) { Text("Delete project…") }
                TextButton(onClick = { clipboard.setText(AnnotatedString("${handle.account.server.trimEnd('/')}/projects/$id")); notice = "Project link copied." }) { Text("Copy link") }
                TextButton(enabled = enabled, onClick = { sharing = true }) { Text("Share…") }
                TextButton(onClick = { clipboard.setText(AnnotatedString("# ${doc.text("title")}\n\n${doc.text("goal").orEmpty()}\n\n" + doc.objects("acceptanceCriteriaItems").joinToString("\n") { "- ${it.text("text")}" })); notice = "Markdown copied." }) { Text("Copy as Markdown") }
            }
        }
    }
    change?.let { pending ->
        var reason by rememberSaveable(pending.title) { mutableStateOf("") }
        AlertDialog(onDismissRequest = { if (!busy) change = null }, title = { Text(pending.title) },
            text = { Column { Text(pending.detail); notice?.let { Text(it, color = MaterialTheme.colorScheme.error) }; if (pending.reason) OutlinedTextField(reason, { reason = it.take(2000) }, label = { Text("Reason") }) } },
            confirmButton = { TextButton(enabled = enabled && (!pending.reason || reason.isNotBlank()), onClick = { execute(pending, reason.takeIf { pending.reason }) }) { Text("Confirm") } },
            dismissButton = { TextButton(enabled = !busy, onClick = { change = null }) { Text("Cancel") } })
    }
    if (settings && displayedPage != null && id != null) ProjectSettingsDialog(displayedPage, enabled, notice, { settings = false }) { title, request -> execute(ProjectChange(title, "", request)) }
    if (sharing && id != null) ProjectShareDialog(id, handle, directory, writes, revision, enabled, { sharing = false })
    if (start && displayedPage != null && id != null) ProjectStartDialog(displayedPage, enabled, notice, { start = false }) { request -> execute(ProjectChange("Start project", "", request)) }
}

@Composable
private fun ProjectIndexRow(project: JsonObject, open: () -> Unit) {
    OutlinedCard(Modifier.fillMaxWidth().testTag("project:${project.text("id")}").clickable(onClick = open)) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(project.text("title") ?: "Project", style = MaterialTheme.typography.titleMedium)
            project.text("goal")?.let { Text(it, maxLines = 2) }
            val buckets = project.obj("buckets")
            Text("${project.obj("_count")?.number("tasks") ?: 0} tasks · ${projectStatus(project)}")
            Text(projectBuckets.mapNotNull { (key, title) -> buckets?.number(key)?.takeIf { it > 0 }?.let { "$title $it" } }.joinToString(" · "), style = MaterialTheme.typography.bodySmall)
            project.obj("attention")?.objects("ownerItems")?.forEach { Text("Needs you · ${it.text("kind")?.lowercase()?.replace('_', ' ')} · ${it.number("count") ?: 0}") }
            if (project.obj("attention")?.obj("startRequest") != null) Text("Needs you · Ready to start")
            project.obj("integration")?.text("ref")?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
        }
    }
}

@Composable
private fun ProjectOpenItems(items: JsonObject, enabled: Boolean,
    review: () -> Unit, open: (String) -> Unit) {
    val rows = listOfNotNull(items.obj("startRequest")) + items.objects("needsYou") + items.objects("withCoordinator")
    if (rows.isEmpty()) return
    Text("Open items", style = MaterialTheme.typography.titleLarge)
    rows.forEach { row ->
        OutlinedCard(Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
            Column(Modifier.padding(12.dp)) {
                Text(row.text("title") ?: "Start this project?", style = MaterialTheme.typography.titleMedium)
                Text(row.text("detailLine").orEmpty())
                Text("${row.text("assignee") ?: "OWNER"} · ${row.text("assigneeReason") ?: ""}")
                row.text("waitingSince")?.let { Text("Waiting since $it", style = MaterialTheme.typography.bodySmall) }
                row.obj("facts")?.obj("task")?.let { task -> TextButton(onClick = { task.text("id")?.let { open("orbit-task:$it") } }) { Text(task.text("title") ?: "Open task") } }
                val verbs = row.strings("actions")
                if (verbs.any { it in setOf("REVIEW", "ANSWER", "OPEN_COORDINATOR", "RETRY", "RESUME", "CANCEL_TASK", "ASK_COORDINATOR_AGAIN") }) {
                    TextButton(enabled = enabled, onClick = review) { Text("Review in coordinator session") }
                }
                if ("OPEN_TASK_SESSION" in verbs) row.text("sessionId")?.let { id -> TextButton(onClick = { open("orbit-session:$id") }) { Text("Open task session") } }
            }
        }
    }
}

@Composable
private fun ProjectOverview(panorama: JsonObject, integration: JsonObject?) {
    Text("Work overview", style = MaterialTheme.typography.titleLarge)
    val buckets = panorama.obj("buckets")
    projectBuckets.forEach { (key, title) -> Text("$title · ${buckets?.number(key) ?: 0}") }
    listOf("integrating" to "Integrating", "onIntegrationLine" to "On project branch", "onUpstream" to "On upstream", "waitingForLanding" to "Waiting for landing").forEach { (key, title) ->
        buckets?.number(key)?.let { Text("$title · $it") }
    }
    integration?.obj("inFlight")?.let { job ->
        OutlinedCard(Modifier.fillMaxWidth()) { Column(Modifier.padding(12.dp)) {
            Text("${job.text("kind") ?: "Integration"} · ${job.text("state")} · ${job.text("phase") ?: "Queued"}", style = MaterialTheme.typography.titleSmall)
            job.text("taskTitle")?.let { Text(it) }
            job.text("startedAt")?.let { Text("Since $it") }
            job.text("heartbeatAt")?.let { Text("Last report $it") }
        } }
    }
    integration?.objects("landTasks")?.forEach { task ->
        val landing = task.obj("integration")?.obj("landTask")
        Text("${task.text("taskTitle")} · ${task.obj("integration")?.text("state") ?: "Unknown"}")
        landing?.obj("blockingReason")?.text("summary")?.let { Text(it) }
    }
}
