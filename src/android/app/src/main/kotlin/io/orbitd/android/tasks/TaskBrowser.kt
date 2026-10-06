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
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.cards.*
import io.orbitd.android.navigation.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*
import java.util.UUID

@Composable
internal fun TaskBrowser(app: OrbitApplication, handle: SessionHandle, route: OrbitRoute, revision: Long,
    open: (OrbitRoute) -> Unit) {
    val api = remember(handle) { TaskApi(app.session, handle) }
    val scope = rememberCoroutineScope()
    val live by app.realtime.state.collectAsState()
    val workspaces = live.directory?.workspaces.orEmpty()
    var listId by rememberSaveable(handle.account.toString(), route) { mutableStateOf(if (route.destination == Destination.LIST) route.id else null) }
    var filter by rememberSaveable { mutableStateOf("") }
    var query by rememberSaveable { mutableStateOf("") }
    var labels by rememberSaveable { mutableStateOf(listOf<String>()) }
    var assignee by rememberSaveable { mutableStateOf<String?>(null) }
    var batches by rememberSaveable { mutableStateOf(false) }
    var sort by rememberSaveable { mutableStateOf("Created") }
    var selecting by rememberSaveable { mutableStateOf(false) }
    var selected by rememberSaveable { mutableStateOf(listOf<String>()) }
    var rows by remember(handle) { mutableStateOf<List<JsonObject>>(emptyList()) }
    var lists by remember(handle) { mutableStateOf<List<JsonObject>>(emptyList()) }
    var counts by remember(handle) { mutableStateOf<JsonObject?>(null) }
    var labelRows by remember(handle) { mutableStateOf<List<JsonObject>>(emptyList()) }
    var header by remember(handle) { mutableStateOf<JsonObject?>(null) }
    var activeRows by remember(handle) { mutableStateOf<List<JsonObject>>(emptyList()) }
    var activeTotal by remember(handle) { mutableIntStateOf(0) }
    var generation by remember(handle) { mutableIntStateOf(0) }
    var cursor by remember(handle) { mutableStateOf<String?>(null) }
    var error by remember(handle) { mutableStateOf<String?>(null) }
    var notice by remember(handle) { mutableStateOf<String?>(null) }
    var loading by remember { mutableStateOf(true) }
    var writing by remember { mutableStateOf(false) }
    var refresh by remember { mutableIntStateOf(0) }
    var batchAction by remember { mutableStateOf<String?>(null) }
    var concurrency by rememberSaveable { mutableStateOf("1") }
    var batchAssignee by rememberSaveable { mutableStateOf<String?>(null) }
    val request = TaskQuery(listId, filter, query, labels, assignee)
    LaunchedEffect(handle, request, revision, refresh) {
        generation++
        activeRows = emptyList(); activeTotal = 0
        loading = true; error = null
        // A search/filter change never leaves old rows selectable under the new heading.
        rows = emptyList(); selected = emptyList(); cursor = null
        delay(200)
        try {
            coroutineScope {
                val page = async { api.page(request) }
                val tally = async { api.read(listOf("tasks", "counts"), request.scope()) as JsonObject }
                val active = async { if (filter.isBlank() && labels.isEmpty() && query.isBlank()) api.read(listOf("tasks", "active"), TaskQuery(listId).scope()) as JsonObject else null }
                val navigation = async { api.read(listOf("task-lists")) }
                val summary = async { api.read(listOf("tasks", "labels"), request.copy(labels = emptyList()).scope()) as JsonObject }
                val listHeader = async { listId?.takeUnless { it == "none" }?.let { api.read(listOf("task-lists", it), listOf("tasks" to "none")) as JsonObject } }
                val result = page.await()
                rows = result.objects("items"); counts = tally.await(); cursor = result.text("nextCursor")
                lists = (navigation.await() as? JsonArray).orEmpty().filterIsInstance<JsonObject>()
                labelRows = summary.await().objects("items"); header = listHeader.await()
                val happening = active.await(); activeRows = happening?.objects("items").orEmpty(); activeTotal = happening?.number("total") ?: 0
            }
        } catch (cancel: CancellationException) { throw cancel }
        catch (failure: Exception) { error = taskError(failure); rows = emptyList(); header = null }
        finally { loading = false }
    }
    fun mutate(operation: suspend () -> Unit) {
        if (writing || loading || live.handle !== handle || !live.directoryFresh) return
        writing = true; error = null; notice = null
        api.authorityRevision = rows.joinToString("|") { "${it.text("id")}:${it.text("updatedAt")}" }
        scope.launch {
            try { operation(); selected = emptyList(); selecting = false; if (notice == null) notice = "Saved. Reading current state…" }
            catch (cancel: CancellationException) { throw cancel }
            catch (failure: Exception) { notice = taskError(failure) }
            finally { writing = false; refresh++; app.realtime.refreshDirectory() }
        }
    }
    val enabled = !loading && !writing && error == null && live.handle === handle && live.directoryFresh
    val sorted = remember(rows, sort) { when (sort) {
        "Title" -> rows.sortedBy { it.text("title")?.lowercase() }
        "Status" -> rows.sortedBy { taskStatus(it) }
        "Assignee" -> rows.sortedBy { it.obj("assignee")?.text("name")?.lowercase() }
        else -> rows
    } }
    LazyColumn(Modifier.fillMaxSize().testTag("tasks-list"), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        item {
            Text(header?.text("title") ?: if (listId == "none") "No list" else "Tasks", style = MaterialTheme.typography.headlineMedium)
            if (!live.directoryFresh) Text("Reconnecting · refresh is required before making changes.", style = MaterialTheme.typography.bodySmall)
            if (listId == null || listId == "none") Text("Tasks outside projects. Project work is on its project page.", style = MaterialTheme.typography.bodySmall)
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TaskChoice("List", listOf(null to "All tasks", "none" to "No list") + lists.filter { row ->
                    (row.obj("_count")?.number("tasks") ?: 0) == 0 || row.number("tasksOutsideProjects") != 0
                }.map { it.text("id") to (it.text("title") ?: "Untitled list") }, listId) { listId = it; labels = emptyList() }
                TaskChoice("Filter", listOf("" to "All", "ONGOING" to "Open", "RUNNABLE" to "Ready", "RUNNING" to "Running", "FAILED" to "Failed", "DONE" to "Done", "CANCELLED" to "Cancelled"), filter) { filter = it.orEmpty() }
                TaskChoice("Assignee", listOf(null to "Everyone") + workspaces.map { it.text("id") to (it.text("name") ?: "Workspace") }, assignee) { assignee = it }
                TaskChoice("Sort", listOf("Created", "Title", "Status", "Assignee").map { it to it }, sort) { sort = it ?: "Created" }
            }
            OutlinedTextField(query, { query = it }, Modifier.fillMaxWidth().testTag("task-search"), label = { Text("Search tasks") }, singleLine = true)
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(!batches, { batches = false }, label = { Text("Tasks") })
                FilterChip(batches, { batches = true }, label = { Text("Batches") })
                TextButton(onClick = { refresh++ }, enabled = !writing) { Text("Refresh") }
                TextButton(onClick = { selecting = !selecting; selected = emptyList() }, enabled = enabled) { Text(if (selecting) "Done selecting" else "Select") }
            }
            counts?.let { value ->
                Text("${value.number("done") ?: 0} of ${value.number("total") ?: 0} done · ${value.number("running") ?: 0} running · ${value.number("failed") ?: 0} failed")
                val total = value.number("total") ?: 0
                if (total > 0) LinearProgressIndicator(progress = { (value.number("done") ?: 0).toFloat() / total }, modifier = Modifier.fillMaxWidth())
                value.obj("inProjects")?.let { other -> TextButton(onClick = { open(OrbitRoute(Destination.PROJECTS)) }) {
                    Text("${other.number("tasks") ?: 0} tasks in ${other.number("projects") ?: 0} projects")
                } }
            }
            if (labelRows.isNotEmpty()) Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                labelRows.forEach { row -> val label = row.text("label") ?: return@forEach
                    FilterChip(label in labels, { labels = if (label in labels) labels - label else labels + label }, label = { Text(label) })
                }
            }
        }
        header?.let { current -> item {
            current.text("instructions")?.takeIf { it.isNotBlank() }?.let { io.orbitd.android.text.MarkdownText(it) }
            Text(if (current.flag("paused")) "Dispatch paused" else "Dispatch active", style = MaterialTheme.typography.labelMedium)
            current.number("maxConcurrent")?.let { Text("Up to $it concurrent tasks") }
            TextButton(onClick = { mutate { open(OrbitRoute(Destination.SESSION, api.console(current.text("id")!!))) } }, enabled = enabled) { Text("Open list conversation") }
        } }
        if (activeRows.isNotEmpty() && !batches && !selecting) {
            item { Text("Happening now · $activeTotal", style = MaterialTheme.typography.titleMedium) }
            items(activeRows, key = { "active:${it.text("id")}" }) { active ->
                TaskRow(active) { open(OrbitRoute(Destination.TASK, active.text("id"))) }
            }
        }
        if (selecting) item {
            Text("${selected.size} selected")
            Row(Modifier.horizontalScroll(rememberScrollState())) {
                TextButton(onClick = { selected = if (selected.size == rows.size) emptyList() else rows.mapNotNull { it.text("id") } }, enabled = enabled) { Text("Select all loaded") }
                listOf("execute" to "Run", "stop" to "Stop", "assign" to "Set assignee", "delete" to "Delete").forEach { (action, label) ->
                    TextButton(onClick = { batchAction = action }, enabled = enabled && selected.isNotEmpty()) { Text(label) }
                }
            }
        }
        if (loading || writing) item { LinearProgressIndicator(Modifier.fillMaxWidth()) }
        error?.let { item { Text(it, color = MaterialTheme.colorScheme.error) } }
        notice?.let { item { Text(it, Modifier.testTag("task-result")) } }
        if (!loading && error == null && rows.isEmpty() && !batches) item { Text("No tasks match this view.") }
        if (batches) items(labelRows.filter { query.isBlank() || it.text("label").orEmpty().contains(query, ignoreCase = true) }, key = { it.text("label").orEmpty() }) { batch ->
            val label = batch.text("label").orEmpty()
            OutlinedCard(onClick = { labels = listOf(label); batches = false }, Modifier.fillMaxWidth()) {
                Column(Modifier.padding(12.dp)) {
                    Text(label, style = MaterialTheme.typography.titleMedium)
                    Text("${batch.number("done") ?: 0} / ${batch.number("total") ?: 0} done · ${batch.number("failed") ?: 0} failed")
                }
            }
        } else items(sorted, key = { it.text("id").orEmpty() }) { row ->
            val id = row.text("id") ?: return@items
            Row(Modifier.fillMaxWidth()) {
                if (selecting) Checkbox(id in selected, { checked -> selected = if (checked) selected + id else selected - id }, enabled = enabled)
                TaskRow(row, Modifier.weight(1f)) {
                    if (selecting) selected = if (id in selected) selected - id else selected + id else open(OrbitRoute(Destination.TASK, id))
                }
            }
        }
        if (cursor != null && !batches) item {
            TextButton(onClick = {
                val expectedGeneration = generation
                val nextCursor = cursor
                if (!loading) scope.launch {
                    loading = true
                    try { val page = api.page(request, nextCursor); if (generation == expectedGeneration) { rows = (rows + page.objects("items")).distinctBy { it.text("id") }; cursor = page.text("nextCursor") } }
                    catch (cancel: CancellationException) { throw cancel }
                    catch (failure: Exception) { if (generation == expectedGeneration) notice = taskError(failure) }
                    finally { if (generation == expectedGeneration) loading = false }
                }
            }, enabled = enabled) { Text("Load more tasks") }
        }
    }
    batchAction?.let { action ->
        AlertDialog(onDismissRequest = { batchAction = null }, title = { Text("${action.replaceFirstChar { it.uppercase() }} ${selected.size} tasks?") },
            text = { Column {
                Text(if (action == "delete") "Deleted tasks cannot be restored. Existing runs are stopped; their sessions remain." else "Orbit checks each task's current permissions and state.")
                if (action == "execute") OutlinedTextField(concurrency, { concurrency = it }, label = { Text("Concurrent tasks (1–100)") })
                if (action == "assign") TaskChoice("Assignee", listOf(null to "Unassigned") + workspaces.map { it.text("id") to (it.text("name") ?: "Workspace") }, batchAssignee) { batchAssignee = it }
            } },
            confirmButton = { TextButton(enabled = enabled && (action != "execute" || concurrency.toIntOrNull() in 1..100), onClick = {
                val ids = selected.toList(); batchAction = null
                mutate { notice = batchResultText(api.batch(action, ids, UUID.randomUUID().toString(), concurrency.toIntOrNull() ?: 1, batchAssignee) as? JsonObject, rows.associate { it.text("id").orEmpty() to it.text("title").orEmpty() }) }
            }) { Text("Confirm") } }, dismissButton = { TextButton(onClick = { batchAction = null }) { Text("Cancel") } })
    }
}

@Composable
internal fun TaskRow(row: JsonObject, modifier: Modifier = Modifier, onClick: () -> Unit) {
    OutlinedCard(onClick, modifier.fillMaxWidth().testTag("task:${row.text("id")}")) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(row.text("title") ?: "Untitled task", style = MaterialTheme.typography.titleMedium)
            Text(listOfNotNull(taskStatus(row), taskPhrase(row)).joinToString(" · "), style = MaterialTheme.typography.bodySmall)
            row.strings("labels").takeIf { it.isNotEmpty() }?.let { Text(it.joinToString(" · "), style = MaterialTheme.typography.labelSmall) }
        }
    }
}

@Composable
internal fun TaskChoice(label: String, options: List<Pair<String?, String>>, selected: String?, enabled: Boolean = true, choose: (String?) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Box {
        TextButton(onClick = { expanded = true }, enabled = enabled) { Text("$label: ${options.firstOrNull { it.first == selected }?.second ?: selected ?: "None"}") }
        DropdownMenu(expanded, { expanded = false }) { options.forEach { (value, title) ->
            DropdownMenuItem(text = { Text(title) }, onClick = { expanded = false; choose(value) })
        } }
    }
}
