package io.orbitd.android.directory

import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.*
import androidx.compose.ui.unit.dp
import io.orbitd.android.R
import io.orbitd.android.navigation.*
import io.orbitd.android.ui.LocalOrbitColors
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay

@Composable
fun DirectoryScreen(route: OrbitRoute, data: DirectoryData, api: DirectoryApi,
    open: (OrbitRoute) -> Unit, refresh: () -> Unit) {
    var view by rememberSaveable { mutableStateOf(SessionView.entries.firstOrNull { it.query == route.sessionView } ?: SessionView.OPEN) }
    var grouping by rememberSaveable { mutableStateOf(Grouping.RECENCY) }
    var tag by rememberSaveable { mutableStateOf<String?>(null) }
    var query by rememberSaveable { mutableStateOf("") }
    var action by remember { mutableStateOf<DirectoryDialog?>(null) }
    val folder = data.folders.firstOrNull { ObjectId.same(it.id, route.id) }
    val workspace = route.workspaceId ?: route.id.orEmpty()
    val isFolder = route.destination == Destination.FOLDER
    val workspaceName = data.workspaces.firstOrNull { ObjectId.same(it.id, workspace) }?.name ?: "Workspace"

    Column(Modifier.fillMaxSize()) {
        OutlinedTextField(query, { query = it }, Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp),
            singleLine = true, label = { Text("Search sessions") },
            trailingIcon = { if (query.isNotEmpty()) TextButton(onClick = { query = "" }) { Text("Clear") } })
        if (query.isNotBlank()) {
            SearchResultsList(query, api, open)
        } else {
            val sessions = data.sessions[view.query].orEmpty()
            val groups = directoryGroups(visibleSessions(sessions, data.folders, workspace,
                if (isFolder) route.id else null, view, tag, grouping == Grouping.TAG), view, grouping)
            val folders = if (isFolder || view == SessionView.TRASH || tag != null || grouping == Grouping.TAG) emptyList() else data.folders.filter { f ->
                ObjectId.same(f.workspaceId, workspace) && (view == SessionView.OPEN && tag == null ||
                    sessions.any { ObjectId.same(it.folderId, f.id) && (tag == null || it.tags.any { t -> ObjectId.same(t.id, tag) }) })
            }.sortedBy { it.name.lowercase() }
            LazyColumn(Modifier.fillMaxSize().testTag("directory-list"), state = rememberLazyListState(), contentPadding = PaddingValues(bottom = 24.dp)) {
                item {
                    Column {
                        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp),
                            horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            SessionView.entries.forEach { option ->
                                FilterChip(selected = view == option, onClick = { view = option }, label = { Text(option.label) })
                            }
                        }
                        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp),
                            horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            TextButton(onClick = { grouping = if (grouping == Grouping.RECENCY) Grouping.TAG else Grouping.RECENCY }) {
                                Text(if (grouping == Grouping.RECENCY) "By time" else "By tag")
                            }
                            FilterChip(tag == null, { tag = null }, label = { Text("All tags") })
                            data.tags.forEach { t -> FilterChip(ObjectId.same(tag, t.id), { tag = t.id }, label = { Text(t.name) }) }
                        }
                    }
                }
                item { DirectoryStatus(data, refresh) }
                if (data.ready && isFolder && folder == null) {
                    item { StatusMessage("Folder unavailable", "It may have been deleted or moved.", refresh) }
                } else {
                    item {
                        Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = 16.dp)) {
                            TextButton(onClick = { open(OrbitRoute(Destination.DRAFT, workspaceId = workspace,
                                folderId = if (isFolder) route.id else null)) }, enabled = data.fresh) { Text("New session") }
                            if (!isFolder && view != SessionView.TRASH) TextButton(onClick = { action = DirectoryDialog.NewFolder(workspace) }, enabled = data.fresh) { Text("New folder") }
                            if (isFolder && folder != null) TextButton(onClick = { action = DirectoryDialog.EditFolder(folder) }) { Text("Folder options") }
                        }
                    }
                    items(folders, key = { "folder:${it.id}" }) { f ->
                        val children = sessions.filter { ObjectId.same(it.folderId, f.id) }
                        ListItem(headlineContent = { Text(f.name) }, leadingContent = { Icon(painterResource(R.drawable.ic_folder), null) },
                            supportingContent = { Text("${children.size} sessions · ${children.sumOf { it.pendingApprovals }} need you · ${children.count { it.runState == "RUNNING" || it.status == "RUNNING" }} running") },
                            trailingContent = { IconButton(onClick = { action = DirectoryDialog.EditFolder(f) }) { Icon(painterResource(R.drawable.ic_more), "Options for ${f.name}") } },
                            modifier = Modifier.clickable(role = Role.Button) { open(OrbitRoute(Destination.FOLDER, f.id, workspace, origin = Origin.LIST, sessionView = view.query)) })
                    }
                    groups.forEach { group ->
                        item(key = "heading:${group.id}") { SectionHeading(group.title) }
                        items(group.sessions, key = { it.id }) { session ->
                            SessionRow(session, { open(OrbitRoute(Destination.SESSION, session.id, workspace, if (isFolder) route.id else null)) },
                                { action = DirectoryDialog.SessionMenu(session, view) })
                        }
                    }
                    if (data.ready && groups.isEmpty() && folders.isEmpty()) item {
                        StatusMessage(if (tag != null) "No matches" else "No ${view.label.lowercase()} sessions",
                            if (isFolder) "Sessions moved here will appear in this folder." else "Sessions in $workspaceName will appear here.")
                    }
                }
            }
        }
    }
    action?.let { DirectoryActionDialog(it, api, data, setDialog = { action = it }, onChanged = refresh) }
}

@Composable
fun SearchScreen(api: DirectoryApi, open: (OrbitRoute) -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    Column(Modifier.fillMaxSize()) {
        OutlinedTextField(query, { query = it }, Modifier.fillMaxWidth().padding(16.dp),
            singleLine = true, label = { Text("Search sessions") },
            trailingIcon = { if (query.isNotEmpty()) TextButton(onClick = { query = "" }) { Text("Clear") } })
        SearchResultsList(query, api, open)
    }
}

@Composable
private fun SearchResultsList(query: String, api: DirectoryApi, open: (OrbitRoute) -> Unit) {
    var results by remember { mutableStateOf<SearchResults?>(null) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var retry by remember { mutableIntStateOf(0) }
    // Cancellation on every edit/disposal prevents an old query or account from replacing new hits.
    LaunchedEffect(query, retry, api) {
        loading = true; results = null; error = null
        delay(250)
        try { results = api.search(query.trim()) }
        catch (cancel: CancellationException) { throw cancel }
        catch (failure: Exception) { error = directoryError(failure) }
        finally { loading = false }
    }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 24.dp)) {
        if (loading) item { LoadingMessage("Searching sessions…") }
        error?.let { item { StatusMessage("Search couldn't be loaded", it, { retry++ }) } }
        results?.let { result ->
            item { SectionHeading(if (query.isBlank()) "Recent sessions" else "${result.hits.size} of ${result.total ?: result.hits.size} matching sessions") }
            if (query.isNotBlank() && !result.contentSearched) item {
                Text("Matching names only — type more to search message text.", Modifier.padding(16.dp), style = MaterialTheme.typography.bodySmall)
            }
            if (result.hits.isEmpty()) item { StatusMessage(if (query.isBlank()) "No sessions yet" else "No matches",
                if (query.isBlank()) "Recent sessions will appear here." else "Try another name or message.") }
            items(result.hits, key = { it.id }) { hit ->
                ListItem(headlineContent = { Text(hit.title) }, supportingContent = {
                    Column { Text(listOfNotNull(hit.agent?.name, hit.lifecycleState, hit.runState ?: hit.status).joinToString(" · "))
                        hit.snippet?.let { Text(it, style = MaterialTheme.typography.bodyMedium) } }
                }, modifier = Modifier.clickable(role = Role.Button) { open(OrbitRoute(Destination.SESSION, hit.id, hit.agent?.id, origin = Origin.SEARCH)) })
            }
        }
    }
}

@Composable
fun SessionRow(session: DirectorySession, onOpen: () -> Unit, onOptions: () -> Unit) {
    ListItem(headlineContent = { Text(session.name) }, supportingContent = {
        Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text(session.stateLabel, color = if (session.pendingApprovals > 0) LocalOrbitColors.current.needsYou else MaterialTheme.colorScheme.onSurfaceVariant)
            (session.lastUserText ?: session.lastAssistantText)?.takeIf { it.isNotBlank() }?.let { Text(it, maxLines = 2, style = MaterialTheme.typography.bodyMedium) }
            if (session.tags.isNotEmpty()) Text(session.tags.joinToString(" · ") { it.name }, style = MaterialTheme.typography.bodySmall)
            if (session.runningBgJobCount > 0) Text("${session.runningBgJobCount} background jobs", style = MaterialTheme.typography.bodySmall)
            if (session.pinnedAt != null) Text("Pinned", style = MaterialTheme.typography.bodySmall)
        }
    }, trailingContent = { IconButton(onOptions) { Icon(painterResource(R.drawable.ic_more), "Options for ${session.name}") } },
        modifier = Modifier.clickable(role = Role.Button, onClick = onOpen))
}

@Composable
fun DirectoryStatus(data: DirectoryData, refresh: () -> Unit) {
    if (data.waitingForConnection) StatusMessage("Waiting for connection", "Connect to the network to load your workspaces.", refresh)
    if (data.refreshing || !data.ready && data.error == null && !data.waitingForConnection) LoadingMessage("Loading workspaces and sessions…")
    data.error?.let { StatusMessage("Couldn't load workspaces", it, refresh) }
    if (data.ready && !data.fresh && data.error == null) Text("Showing saved sessions. Connecting to Orbit…", Modifier.padding(16.dp), style = MaterialTheme.typography.bodySmall)
}

@Composable
fun LoadingMessage(message: String) {
    Row(Modifier.padding(16.dp).semantics { liveRegion = LiveRegionMode.Polite }, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        CircularProgressIndicator(Modifier.size(24.dp)); Text(message)
    }
}

@Composable
fun StatusMessage(title: String, message: String, retry: (() -> Unit)? = null) {
    Column(Modifier.fillMaxWidth().padding(24.dp).semantics { liveRegion = LiveRegionMode.Polite }, verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text(title, style = MaterialTheme.typography.titleMedium)
        Text(message, style = MaterialTheme.typography.bodyMedium)
        retry?.let { Button(onClick = it) { Text("Retry") } }
    }
}

@Composable
fun SectionHeading(title: String) {
    Text(title, Modifier.padding(horizontal = 16.dp, vertical = 12.dp).semantics { heading() },
        style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
}
