package io.orbitd.android.tasks

import android.content.Context
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.cards.*
import io.orbitd.android.core.net.ApiError
import io.orbitd.android.navigation.*
import io.orbitd.android.taskprojects.canWrite
import io.orbitd.android.taskprojects.writable
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.*
import java.util.UUID

private const val FILTER_PREFERENCE = "orbit.tasks.filter"

/** What one scope's reads produced. Rows stay on screen while they are read again: a live event
 * or a reconnect re-reads in place (iOS reconciles rows by id), and only a new query starts empty. */
private class TaskListData {
    var rows by mutableStateOf<List<JsonObject>>(emptyList())
    var cursor by mutableStateOf<String?>(null)
    var overview by mutableStateOf<TaskOverview?>(null)
    var pinned by mutableStateOf<List<JsonObject>>(emptyList())
    var pinnedTotal by mutableIntStateOf(0)
    var labels by mutableStateOf<JsonObject?>(null)
    var lists by mutableStateOf<List<JsonObject>>(emptyList())
    var unlisted by mutableIntStateOf(0)
    var header by mutableStateOf<JsonObject?>(null)
    var loaded by mutableStateOf(false)
    var loading by mutableStateOf(false)
    var loadingMore by mutableStateOf(false)
    var error by mutableStateOf<String?>(null)
    var conflict by mutableStateOf<TaskRunHandoff.Conflict?>(null)
    var busy by mutableStateOf<Set<String>>(emptySet())
    var generation = 0
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
internal fun TaskBrowser(app: OrbitApplication, handle: SessionHandle, route: OrbitRoute, revision: Long, open: (OrbitRoute) -> Unit) {
    val context = LocalContext.current
    val preferences = remember { context.getSharedPreferences("orbit.tasks", Context.MODE_PRIVATE) }
    val api = remember(handle) { TaskApi(app.session, handle) { app.canWrite(handle) } }
    val scope = rememberCoroutineScope()
    val live by app.realtime.state.collectAsState()
    val auth by app.session.state.collectAsState()
    val connected = writable(live, handle, (auth as? AuthState.SignedIn)?.handle)
    val workspaces = live.directory?.workspaces.orEmpty()
    val routeList = if (route.destination == Destination.LIST) route.id else null
    var listId by rememberSaveable(handle.account.toString(), route) { mutableStateOf(routeList) }
    var filter by rememberSaveable { mutableStateOf(TaskFilter.remembered(preferences.getString(FILTER_PREFERENCE, null))) }
    var search by rememberSaveable(listId) { mutableStateOf("") }
    var labels by rememberSaveable(listId) { mutableStateOf(listOf<String>()) }
    var sort by rememberSaveable(listId) { mutableStateOf(TaskSort.CREATED) }
    var descending by rememberSaveable(listId) { mutableStateOf(true) }
    var batches by rememberSaveable { mutableStateOf(false) }
    var labelQuery by rememberSaveable { mutableStateOf("") }
    var selecting by rememberSaveable { mutableStateOf(false) }
    var selected by rememberSaveable { mutableStateOf(listOf<String>()) }
    var batchAction by remember { mutableStateOf<TaskBatchAction?>(null) }
    var toDelete by remember { mutableStateOf<JsonObject?>(null) }
    var directoryOpen by rememberSaveable { mutableStateOf(false) }
    var labelsOpen by rememberSaveable { mutableStateOf(false) }
    val data = remember(handle) { TaskListData() }
    val query = TaskQuery(listId, filter, search, labels)

    suspend fun navigation() {
        coroutineScope {
            val lists = async { runCatching { api.lists() }.getOrNull() }
            val unlisted = async { runCatching { api.unlistedCount() }.getOrNull() }
            lists.await()?.let { data.lists = it }
            unlisted.await()?.let { data.unlisted = it }
        }
    }
    /** One scope's page and the bounded reads beside it. The page decides the error; the strip,
     * the counts and the label table are optional — a failed one keeps what it last showed. */
    suspend fun load(reset: Boolean) {
        val generation = if (reset) ++data.generation else data.generation
        if (reset) { data.rows = emptyList(); data.cursor = null; data.overview = null; data.pinned = emptyList(); data.pinnedTotal = 0; data.labels = null; data.loaded = false }
        data.loading = true
        try {
            coroutineScope {
                val counts = async { runCatching { api.counts(query) }.getOrNull() }
                val pinned = async { if (TaskListLogic.pinsHappeningNow(filter, null, labels)) runCatching { api.active(query) }.getOrNull() else null }
                val labelTable = async { runCatching { api.labels(query) }.getOrNull() }
                val header = async { listId?.takeIf { it != "none" && data.lists.none { list -> ObjectId.same(list.text("id"), it) } }
                    ?.let { runCatching { api.listHeader(it) }.getOrNull() } }
                val page = api.page(query)
                if (generation != data.generation) return@coroutineScope
                // The first page is read again in place; rows a reader paged in beyond it are kept.
                val first = page.objects("items")
                val firstIds = first.mapNotNull { it.text("id") }.toSet()
                data.rows = if (reset || data.cursor == null) first else first + data.rows.drop(200).filter { it.text("id") !in firstIds }
                if (reset || data.rows.size <= 200) data.cursor = page.text("nextCursor")
                data.error = null; data.loaded = true
                counts.await()?.let { if (generation == data.generation) data.overview = TaskOverview.of(it) }
                pinned.await().let { if (generation == data.generation) { data.pinned = it?.objects("items").orEmpty(); data.pinnedTotal = it?.number("total") ?: 0 } }
                labelTable.await()?.let { if (generation == data.generation) data.labels = it }
                header.await()?.let { if (generation == data.generation) data.header = it }
            }
        } catch (cancel: CancellationException) { throw cancel }
        catch (failure: Exception) { if (generation == data.generation) data.error = taskError(failure) }
        finally { if (generation == data.generation) data.loading = false }
    }
    // A new query starts empty after the browser's 250 ms debounce; the same query re-reads in place.
    LaunchedEffect(handle, query) { delay(250); load(reset = true) }
    LaunchedEffect(handle, revision) { if (revision > 0) { delay(400); navigation(); if (data.loaded) load(reset = false) } }
    LaunchedEffect(handle) { navigation() }
    LaunchedEffect(data.rows, data.pinned) {
        // A selection keeps only rows still listed; a task deleted elsewhere is not acted on blind.
        val listed = (data.rows + data.pinned).mapNotNull { it.text("id") }.toSet()
        if (selected.any { it !in listed }) selected = selected.filter { it in listed }
    }

    fun mutate(id: String?, operation: suspend () -> Unit) {
        if (id != null && id in data.busy) return
        data.error = null; data.conflict = null
        id?.let { data.busy = data.busy + it }
        scope.launch {
            try { operation() }
            catch (cancel: CancellationException) { throw cancel }
            catch (failure: Exception) {
                val conflict = TaskRunHandoff.readConflict(failure)
                if (conflict != null) data.conflict = conflict else data.error = taskError(failure)
            } finally {
                id?.let { data.busy = data.busy - it }
                load(reset = false); navigation()
            }
        }
    }
    fun revisionOf(task: JsonObject) = "${task.text("id")}:${task.text("updatedAt")}"
    fun run(task: JsonObject) { val id = task.text("id") ?: return; mutate(id) { api.execute(id, UUID.randomUUID().toString(), revisionOf(task)) } }

    val scopeTitle = when (listId) {
        null -> TaskListCopy.allTasks
        "none" -> TaskListCopy.noList
        else -> data.lists.firstOrNull { ObjectId.same(it.text("id"), listId) }?.text("title") ?: data.header?.text("title") ?: "Task List"
    }
    val overview = data.overview ?: TaskOverview()
    val pinnedShown = if (!batches && TaskListLogic.pinsHappeningNow(filter, null, labels)) TaskListLogic.sorted(data.pinned, TaskSort.STATUS, false) else emptyList()
    val pinnedIds = pinnedShown.mapNotNull { it.text("id")?.let(ObjectId::canonical) }.toSet()
    val rest = TaskListLogic.sorted(data.rows, sort, descending).filter { ObjectId.canonical(it.text("id").orEmpty()) !in pinnedIds }
    val allIds = (pinnedShown + rest).mapNotNull { it.text("id") }

    Column(Modifier.fillMaxSize()) {
        // The bar: the scope switcher and the one options menu — or, while selecting, the bulk bar.
        if (selecting) Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            val all = allIds.isNotEmpty() && selected.containsAll(allIds)
            TextButton(onClick = { selected = if (all) emptyList() else allIds }) { Text(if (all) TaskListCopy.deselectAll else TaskListCopy.selectAll) }
            Text(TaskListCopy.selected(selected.size), Modifier.weight(1f), style = MaterialTheme.typography.titleSmall)
            TextButton(onClick = { selecting = false; selected = emptyList() }, modifier = Modifier.testTag("tasks-select-done")) { Text("Done", fontWeight = FontWeight.SemiBold) }
        } else Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = { directoryOpen = true }, modifier = Modifier.weight(1f).testTag("tasks-scope")) {
                Text("$scopeTitle ▾", maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleMedium,
                    modifier = Modifier.fillMaxWidth())
            }
            TaskOptionsMenu(batches, sort, descending, labels.isNotEmpty(),
                select = { selecting = true; selected = emptyList() },
                view = { batches = it; selecting = false; selected = emptyList() },
                pickSort = { sort = it; descending = it == TaskSort.CREATED }, order = { descending = it },
                labels = { labelsOpen = true }, refresh = { scope.launch { navigation(); load(reset = false) } })
        }
        if (batches) OutlinedTextField(labelQuery, { labelQuery = it }, Modifier.fillMaxWidth().padding(horizontal = 16.dp).testTag("task-label-search"),
            label = { Text(TaskListCopy.searchLabels) }, singleLine = true, keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search))
        else OutlinedTextField(search, { search = it }, Modifier.fillMaxWidth().padding(horizontal = 16.dp).testTag("task-search"),
            label = { Text(TaskListCopy.searchTasks) }, singleLine = true, keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search))
        Box(Modifier.weight(1f)) {
            LazyColumn(Modifier.fillMaxSize().testTag("tasks-list"), contentPadding = PaddingValues(start = 16.dp, end = 16.dp, bottom = 24.dp)) {
                item {
                    Column(Modifier.padding(top = 8.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                        if (!connected) OfflineNote()
                        data.error?.takeIf { data.rows.isNotEmpty() }?.let { TaskErrorBanner(it) { data.error = null } }
                        data.conflict?.let { conflict -> TaskRunConflictCard(conflict, { open(OrbitRoute(Destination.SESSION, it)) },
                            conflict.taskId?.let { task -> { mutate(task) { api.update(task, buildJsonObject { put("provider", JsonNull); put("model", JsonNull) }, "pin:$task") } } }) { data.conflict = null } }
                        listId?.takeIf { it != "none" }?.let { id -> SteeringSessionButton(connected) {
                            scope.launch {
                                try { open(OrbitRoute(Destination.SESSION, api.console(id))) }
                                catch (cancel: CancellationException) { throw cancel }
                                catch (failure: Exception) { data.error = taskError(failure) }
                            }
                        } }
                        if (overview.total > 0) TaskProgressLine(overview)
                        val inProjects = overview.inProjectsTasks ?: 0
                        if (query.projectId != null && inProjects > 0) Text("${TaskListCopy.scopeNoteLead} $inProjects ${TaskListCopy.scopeNoteTail(overview.inProjectsProjects ?: 0)} ${TaskListCopy.projectsLink}",
                            Modifier.clickable(role = Role.Button) { open(OrbitRoute(Destination.PROJECTS, origin = Origin.LIST)) }.testTag("tasks-scope-note"),
                            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                if (!batches) item {
                    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(vertical = 6.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        TaskListLogic.availableFilters(overview, filter).forEach { option ->
                            val count = overview.count(option)
                            FilterChip(filter == option, { filter = option; preferences.edit().putString(FILTER_PREFERENCE, option.name).apply() },
                                label = { Text("${option.title} $count") }, modifier = Modifier.testTag("task-filter:${option.name}"))
                        }
                    }
                }
                if (labels.isNotEmpty()) item {
                    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        labels.forEach { label -> InputChip(true, { labels = labels - label }, label = { Text(label) },
                            trailingIcon = { Text("✕") }, modifier = Modifier.semantics { contentDescription = "Remove $label" }) }
                    }
                }
                if (batches) {
                    val table = data.labels
                    val rows = table?.objects("items").orEmpty().filter { labelQuery.isBlank() || it.text("label").orEmpty().contains(labelQuery.trim(), ignoreCase = true) }
                    item { TaskSectionHeader(TaskListCopy.batchesView, table?.number("labelTotal")?.toString(), trailing = {
                        Text(TaskListCopy.byLabel, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }) }
                    items(rows, key = { "batch:${it.text("label")}" }) { row -> TaskBatchRow(row) { labels = listOf(row.text("label").orEmpty()); batches = false } }
                    if (table?.flag("truncated") == true) item {
                        Text(TaskListCopy.showingLargest(table.objects("items").size, table.number("labelTotal") ?: 0), style = MaterialTheme.typography.bodySmall)
                    }
                    if (table != null && table.objects("items").isEmpty()) item { EmptyState(TaskListCopy.batchesView, TaskListCopy.noLabels) }
                } else {
                    if (pinnedShown.isNotEmpty()) {
                        item { TaskSectionHeader(TaskListCopy.happeningNow, data.pinnedTotal.toString()) }
                        items(pinnedShown, key = { "pinned:${it.text("id")}" }) { task -> ListedTask(task, selecting, task.text("id") in selected,
                            { id -> selected = if (id in selected) selected - id else selected + id }, open, { run(it) }, { toDelete = it }, connected, data.busy) }
                    }
                    if (rest.isNotEmpty()) {
                        item { TaskSectionHeader(TaskListCopy.restHeader(sort, descending)) }
                        items(rest, key = { "row:${it.text("id")}" }) { task -> ListedTask(task, selecting, task.text("id") in selected,
                            { id -> selected = if (id in selected) selected - id else selected + id }, open, { run(it) }, { toDelete = it }, connected, data.busy) }
                    }
                    if (data.cursor != null) item {
                        TextButton(onClick = {
                            val cursor = data.cursor ?: return@TextButton
                            val generation = data.generation
                            data.loadingMore = true
                            scope.launch {
                                try {
                                    val page = api.page(query, cursor)
                                    if (generation == data.generation) {
                                        val known = data.rows.mapNotNull { it.text("id") }.toSet()
                                        data.rows = data.rows + page.objects("items").filter { it.text("id") !in known }
                                        data.cursor = page.text("nextCursor")
                                    }
                                } catch (cancel: CancellationException) { throw cancel }
                                catch (failure: Exception) { if (generation == data.generation) data.error = taskError(failure) }
                                finally { if (generation == data.generation) data.loadingMore = false }
                            }
                        }, enabled = !data.loadingMore && !data.loading, modifier = Modifier.fillMaxWidth().testTag("tasks-load-more")) {
                            Text(if (data.loadingMore) TaskListCopy.loading else TaskListCopy.loadMore)
                        }
                    }
                    if (data.loaded && pinnedShown.isEmpty() && rest.isEmpty()) item {
                        val q = search.trim()
                        EmptyState(if (q.isEmpty()) TaskListLogic.emptyTitle(listId, filter) else TaskListCopy.noneMatch(q), null)
                    }
                }
            }
            if (data.loading && data.rows.isEmpty() && !data.loaded) CircularProgressIndicator(Modifier.align(Alignment.Center))
            else if (!data.loaded && data.error != null) Column(Modifier.align(Alignment.Center).padding(24.dp).testTag("tasks-load-failed"),
                horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(TaskListCopy.loadFailed, style = MaterialTheme.typography.titleMedium)
                Text(data.error.orEmpty(), style = MaterialTheme.typography.bodySmall)
                Button(onClick = { scope.launch { load(reset = true) } }) { Text("Retry") }
            }
        }
        if (selecting) Row(Modifier.fillMaxWidth().padding(8.dp).testTag("tasks-bulk-bar"), horizontalArrangement = Arrangement.SpaceBetween) {
            val enabled = connected && selected.isNotEmpty() && selected.size <= TaskApi.BATCH_LIMIT
            TextButton(onClick = { batchAction = TaskBatchAction.RUN }, enabled = enabled) { Text(TaskListCopy.run) }
            TextButton(onClick = { batchAction = TaskBatchAction.STOP }, enabled = enabled) { Text(TaskListCopy.stop) }
            TextButton(onClick = { batchAction = TaskBatchAction.ASSIGN }, enabled = enabled) { Text(TaskListCopy.setAssignee) }
            TextButton(onClick = { batchAction = TaskBatchAction.DELETE }, enabled = enabled) { Text(TaskListCopy.delete, color = MaterialTheme.colorScheme.error) }
        }
    }

    batchAction?.let { action ->
        val ids = selected.toList()
        fun finish(assignee: String? = null) {
            batchAction = null
            val trigger = UUID.randomUUID().toString()
            mutate(null) {
                api.batch(action, ids, trigger, assignee, revision = ids.sorted().joinToString(",") + ":" + trigger)
                selecting = false; selected = emptyList()
            }
        }
        AlertDialog(onDismissRequest = { batchAction = null }, title = { Text(TaskListCopy.batchTitle(action, ids.size)) },
            text = { Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(TaskListCopy.batchMessage(action, ids.size))
                if (action == TaskBatchAction.ASSIGN) {
                    workspaces.forEach { workspace -> TextButton(onClick = { finish(workspace.text("id")) }, enabled = connected) { Text(workspace.text("name") ?: "Workspace") } }
                    TextButton(onClick = { finish(null) }, enabled = connected) { Text(TaskListCopy.unassigned) }
                }
            } },
            confirmButton = { if (action != TaskBatchAction.ASSIGN) TextButton(onClick = { finish() }, enabled = connected, modifier = Modifier.testTag("tasks-bulk-confirm")) {
                Text(when (action) { TaskBatchAction.RUN -> TaskListCopy.run; TaskBatchAction.STOP -> TaskListCopy.stop; else -> TaskListCopy.delete },
                    color = if (action == TaskBatchAction.RUN) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.error)
            } },
            dismissButton = { TextButton(onClick = { batchAction = null }) { Text("Cancel") } })
    }
    toDelete?.let { task ->
        AlertDialog(onDismissRequest = { toDelete = null }, title = { Text(TaskListCopy.deleteTitle) }, text = { Text(TaskListCopy.deleteMessage) },
            confirmButton = { TextButton(onClick = {
                toDelete = null
                val id = task.text("id") ?: return@TextButton
                mutate(id) { api.delete(id, revisionOf(task)) }
            }, enabled = connected) { Text("Delete ${task.text("title").orEmpty()}", color = MaterialTheme.colorScheme.error) } },
            dismissButton = { TextButton(onClick = { toDelete = null }) { Text("Cancel") } })
    }
    if (directoryOpen) TaskListsDirectory(data.lists, data.unlisted, listId, close = { directoryOpen = false }) { picked ->
        directoryOpen = false
        if (picked != listId) { listId = picked; selecting = false; selected = emptyList() }
    }
    if (labelsOpen) TaskLabelsSheet(data.labels?.objects("items").orEmpty(), labels, close = { labelsOpen = false }) { picked ->
        labelsOpen = false; labels = picked
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ListedTask(task: JsonObject, selecting: Boolean, checked: Boolean, toggle: (String) -> Unit, open: (OrbitRoute) -> Unit,
    run: (JsonObject) -> Unit, delete: (JsonObject) -> Unit, connected: Boolean, busy: Set<String>) {
    val id = task.text("id") ?: return
    var menu by remember { mutableStateOf(false) }
    Box {
        Row(Modifier.fillMaxWidth().testTag("task:$id").combinedClickable(
            onClick = { if (selecting) toggle(id) else open(OrbitRoute(Destination.TASK, id)) },
            onLongClick = { if (!selecting) menu = true }), verticalAlignment = Alignment.CenterVertically) {
            if (selecting) Checkbox(checked, { toggle(id) })
            TaskRowView(task, Modifier.weight(1f))
        }
        DropdownMenu(menu, { menu = false }) {
            // A task already going offers its run instead of a press that can only be refused.
            val entry = TaskRunHandoff.entry(task)
            if (entry.kind == TaskRunHandoff.EntryKind.OPEN_RUN) DropdownMenuItem(text = { Text(entry.label) }, onClick = {
                menu = false; open(OrbitRoute(if (entry.sessionId != null) Destination.SESSION else Destination.TASK, entry.sessionId ?: id))
            }) else if (TaskListLogic.canStart(task)) DropdownMenuItem(text = { Text(entry.label) }, enabled = connected && id !in busy,
                onClick = { menu = false; run(task) })
            DropdownMenuItem(text = { Text(TaskListCopy.delete, color = MaterialTheme.colorScheme.error) }, enabled = connected && id !in busy,
                onClick = { menu = false; delete(task) })
        }
    }
    HorizontalDivider()
}

@Composable
private fun TaskOptionsMenu(batches: Boolean, sort: TaskSort, descending: Boolean, labelled: Boolean, select: () -> Unit, view: (Boolean) -> Unit,
    pickSort: (TaskSort) -> Unit, order: (Boolean) -> Unit, labels: () -> Unit, refresh: () -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        TextButton(onClick = { open = true }, modifier = Modifier.testTag("tasks-options").semantics { contentDescription = "Task options" }) {
            Text(if (labelled) "⋯ •" else "⋯", style = MaterialTheme.typography.titleLarge)
        }
        DropdownMenu(open, { open = false }) {
            DropdownMenuItem(text = { Text(TaskListCopy.selectTasks) }, enabled = !batches, onClick = { open = false; select() })
            HorizontalDivider()
            Text(TaskListCopy.viewAs, Modifier.padding(horizontal = 12.dp, vertical = 4.dp), style = MaterialTheme.typography.labelMedium)
            DropdownMenuItem(text = { Text(TaskListCopy.tasksView) }, leadingIcon = { Text(if (!batches) "✓" else " ") }, onClick = { open = false; view(false) })
            DropdownMenuItem(text = { Column { Text(TaskListCopy.batchesView); Text(TaskListCopy.groupedByLabel, style = MaterialTheme.typography.bodySmall) } },
                leadingIcon = { Text(if (batches) "✓" else " ") }, onClick = { open = false; view(true) })
            HorizontalDivider()
            Text("${TaskListCopy.sortBy} · ${TaskListCopy.restHeader(sort, descending)}", Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
                style = MaterialTheme.typography.labelMedium)
            TaskSort.entries.forEach { option -> DropdownMenuItem(text = { Text(option.title) }, leadingIcon = { Text(if (option == sort) "✓" else " ") },
                onClick = { open = false; pickSort(option) }) }
            DropdownMenuItem(text = { Text("Descending") }, leadingIcon = { Text(if (descending) "✓" else " ") }, onClick = { open = false; order(true) })
            DropdownMenuItem(text = { Text("Ascending") }, leadingIcon = { Text(if (!descending) "✓" else " ") }, onClick = { open = false; order(false) })
            HorizontalDivider()
            DropdownMenuItem(text = { Text(TaskListCopy.filterByLabel) }, onClick = { open = false; labels() })
            DropdownMenuItem(text = { Text("Refresh") }, onClick = { open = false; refresh() })
        }
    }
}

@Composable
private fun SteeringSessionButton(enabled: Boolean, open: () -> Unit) {
    FilledTonalButton(onClick = open, enabled = enabled, modifier = Modifier.testTag("task-list-steering")) { Text(TaskListCopy.steeringSession) }
}

/** The bar and "Done 648 / 704": the one number the chips do not say. */
@Composable
private fun TaskProgressLine(overview: TaskOverview) {
    Column(verticalArrangement = Arrangement.spacedBy(5.dp), modifier = Modifier.testTag("tasks-progress")) {
        LinearProgressIndicator(progress = { overview.done.toFloat() / maxOf(overview.total, 1) }, modifier = Modifier.fillMaxWidth(),
            color = io.orbitd.android.ui.LocalOrbitColors.current.success)
        Text("Done ${overview.done} / ${overview.total}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

/** One label's progress: the label and how many are done, then a bar and how many are left. */
@Composable
private fun TaskBatchRow(row: JsonObject, open: () -> Unit) {
    val total = row.number("total") ?: 0
    val done = row.number("done") ?: 0
    Column(Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = open).padding(vertical = 8.dp).testTag("batch:${row.text("label")}"),
        verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(row.text("label").orEmpty(), Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis, fontWeight = FontWeight.Medium)
            Text("$done / $total ›", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            LinearProgressIndicator(progress = { done.toFloat() / maxOf(total, 1) }, modifier = Modifier.width(150.dp),
                color = io.orbitd.android.ui.LocalOrbitColors.current.success)
            Text(TaskListCopy.left(maxOf(total - done, 0)), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
    HorizontalDivider()
}

@Composable
private fun EmptyState(title: String, detail: String?) {
    Column(Modifier.fillMaxWidth().padding(vertical = 32.dp).testTag("tasks-empty"), horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(title, style = MaterialTheme.typography.titleMedium)
        detail?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
    }
}

/** The directory of lists: All tasks, No list, then Active and Completed lists, searchable. */
@Composable
private fun TaskListsDirectory(lists: List<JsonObject>, unlisted: Int, current: String?, close: () -> Unit, pick: (String?) -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    val q = query.trim()
    val owned = lists.filter { !TaskListLogic.isProjectOnlyList(it) && (q.isEmpty() || it.text("title").orEmpty().contains(q, ignoreCase = true)) }
    val active = owned.filter { !TaskListLogic.listIsCompleted(it) }
    val completed = owned.filter(TaskListLogic::listIsCompleted)
    AlertDialog(onDismissRequest = close, title = { Text(TaskListCopy.taskListsTitle) }, confirmButton = { TextButton(onClick = close) { Text("Done") } },
        text = {
            LazyColumn(Modifier.heightIn(max = 480.dp).testTag("task-lists-directory")) {
                item { OutlinedTextField(query, { query = it }, Modifier.fillMaxWidth(), label = { Text(TaskListCopy.searchLists) }, singleLine = true) }
                if (q.isEmpty()) {
                    item { ScopeRow(TaskListCopy.allTasks, null, current == null) { pick(null) } }
                    item { ScopeRow(TaskListCopy.noList, unlisted, current == "none") { pick("none") } }
                }
                if (active.isNotEmpty()) item { Text("Active", style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(top = 10.dp)) }
                items(active, key = { "active:${it.text("id")}" }) { list -> ListRow(list, false, ObjectId.same(list.text("id"), current)) { pick(list.text("id")) } }
                if (completed.isNotEmpty()) item { Text("Completed", style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(top = 10.dp)) }
                items(completed, key = { "done:${it.text("id")}" }) { list -> ListRow(list, true, ObjectId.same(list.text("id"), current)) { pick(list.text("id")) } }
                if (q.isNotEmpty() && active.isEmpty() && completed.isEmpty()) item {
                    Column { Text(TaskListCopy.noMatchingLists, style = MaterialTheme.typography.titleSmall); Text(TaskListCopy.noListMatches(q), style = MaterialTheme.typography.bodySmall) }
                }
            }
        })
}

@Composable
private fun ScopeRow(title: String, count: Int?, selected: Boolean, pick: () -> Unit) {
    Row(Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = pick).padding(vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(title, Modifier.weight(1f))
        count?.let { Text("$it", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        if (selected) Text("  ✓", color = MaterialTheme.colorScheme.primary)
    }
}

@Composable
private fun ListRow(list: JsonObject, completed: Boolean, selected: Boolean, pick: () -> Unit) {
    val running = (list.number("runningTasks") ?: 0) > 0
    Row(Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = pick).padding(vertical = 10.dp).testTag("task-list:${list.text("id")}"),
        verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        if (running) CircularProgressIndicator(Modifier.size(12.dp), strokeWidth = 1.5.dp) else Text(if (completed) "✓" else "•",
            color = if (completed) io.orbitd.android.ui.LocalOrbitColors.current.success else MaterialTheme.colorScheme.onSurfaceVariant)
        Text(list.text("title").orEmpty(), Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis,
            color = if (completed) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.onSurface)
        Text("${TaskListLogic.taskCount(list)}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (selected) Text("✓", color = MaterialTheme.colorScheme.primary)
    }
}

/** The labels picker: searchable, several at once, each with its count; Clear and Done. */
@Composable
private fun TaskLabelsSheet(rows: List<JsonObject>, initial: List<String>, close: () -> Unit, apply: (List<String>) -> Unit) {
    var picked by rememberSaveable { mutableStateOf(initial) }
    var query by rememberSaveable { mutableStateOf("") }
    val shown = rows.filter { query.isBlank() || it.text("label").orEmpty().contains(query.trim(), ignoreCase = true) }
    AlertDialog(onDismissRequest = close, title = { Text(TaskListCopy.labelsTitle) },
        confirmButton = { TextButton(onClick = { apply(rows.mapNotNull { it.text("label") }.filter { it in picked }) }, modifier = Modifier.testTag("task-labels-done")) { Text("Done") } },
        dismissButton = { TextButton(onClick = { picked = emptyList() }, enabled = picked.isNotEmpty()) { Text(TaskListCopy.clearLabels) } },
        text = {
            LazyColumn(Modifier.heightIn(max = 460.dp).testTag("task-labels")) {
                item { OutlinedTextField(query, { query = it }, Modifier.fillMaxWidth(), label = { Text(TaskListCopy.searchLabels) }, singleLine = true) }
                items(shown, key = { it.text("label").orEmpty() }) { row ->
                    val label = row.text("label").orEmpty()
                    Row(Modifier.fillMaxWidth().clickable(role = Role.Checkbox) { picked = if (label in picked) picked - label else picked + label }
                        .padding(vertical = 8.dp).testTag("task-label:$label"), verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(label in picked, null)
                        Text(label, Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text("${row.number("total") ?: 0}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
        })
}
