package io.orbitd.android.navigation

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import io.orbitd.android.directory.*
import io.orbitd.android.core.net.ApiError
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.*
import io.orbitd.android.text.*

/** The shared route boundary for A06/A07/A11/A12/A13. It resolves real objects already;
 * feature pages replace this overview without changing object identity or its return stack. */
@Composable
fun ObjectDestination(route: OrbitRoute, api: DirectoryApi, data: DirectoryData,
    revision: Long, open: (OrbitRoute) -> Unit, refresh: () -> Unit) {
    var content by remember(route) { mutableStateOf<JsonElement?>(null) }
    var error by remember(route) { mutableStateOf<String?>(null) }
    var loading by remember(route) { mutableStateOf(true) }
    var fresh by remember(route) { mutableStateOf(false) }
    var retry by remember { mutableIntStateOf(0) }
    var action by remember { mutableStateOf<DirectoryDialog?>(null) }
    val path = when (route.destination) {
        Destination.SESSION -> listOf("sessions", route.id!!)
        Destination.TASK -> listOf("tasks", route.id!!)
        Destination.PROJECT -> listOf("projects", route.id!!)
        Destination.RUNNER -> listOf("runners", route.id!!)
        Destination.PROJECTS -> listOf("projects")
        Destination.TASKS -> listOf("tasks")
        Destination.LIST -> listOf("task-lists", route.id!!)
        else -> emptyList()
    }
    LaunchedEffect(route, revision, retry) {
        if (path.isEmpty()) { loading = false; return@LaunchedEffect }
        loading = true; error = null; fresh = false
        try { content = api.read(path, JsonElement.serializer(),
            if (route.destination == Destination.LIST) listOf("tasks" to "none") else emptyList()); fresh = true }
        catch (cancel: CancellationException) { throw cancel }
        catch (failure: Exception) {
            error = directoryError(failure)
            if (failure is ApiError && failure.status in setOf(403, 404)) { content = null; action = null }
        }
        finally { loading = false }
    }
    fun field(obj: JsonObject, name: String) = (obj[name] as? JsonPrimitive)?.contentOrNull
    // Build one interval set per composition, even if a response arrives during measurement.
    val displayedContent = content
    val displayedError = error
    val displayedLoading = loading
    val displayedFresh = fresh
    val resources = LocalReaderResources.current
    val textLink = resources?.let { rememberReaderLinkHandler(it, open) } ?: { raw: String -> OrbitLinks.parse(raw)?.let(open); Unit }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        if (displayedLoading) item { LoadingMessage("Loading…") }
        displayedError?.let { item { StatusMessage("Couldn't open this item", it, { retry++ }) } }
        if (displayedContent != null && !displayedFresh && !displayedLoading) item {
            Text("Showing previously loaded details. Reconnect and retry before making changes.")
        }
        if (route.destination == Destination.DRAFT) item {
            Text("New session", style = MaterialTheme.typography.headlineMedium)
            Text(data.workspaces.firstOrNull { ObjectId.same(it.id, route.workspaceId) }?.name ?: "Workspace unavailable")
            route.folderId?.let { id -> Text(data.folders.firstOrNull { ObjectId.same(it.id, id) }?.name ?: "Folder unavailable") }
        }
        val list = (displayedContent as? JsonArray)?.filterIsInstance<JsonObject>()
        if (list != null) {
            if (list.isEmpty()) item { StatusMessage("No items yet", "Items from your instance will appear here.") }
            items(list, key = { field(it, "id").orEmpty() }) { obj ->
                val id = field(obj, "id")
                val destination = when (route.destination) {
                    Destination.PROJECTS -> Destination.PROJECT
                    else -> Destination.TASK
                }
                ListItem(headlineContent = { Text(field(obj, "title") ?: field(obj, "name") ?: "Untitled") },
                    supportingContent = { field(obj, "status")?.let { Text(it) } },
                    modifier = Modifier.clickable(enabled = id != null && displayedFresh, role = Role.Button) { open(OrbitRoute(destination, id)) })
            }
        }
        (displayedContent as? JsonObject)?.let { obj ->
            item {
                Text(field(obj, "title") ?: field(obj, "name") ?: route.destination.name.lowercase().replaceFirstChar(Char::uppercase), style = MaterialTheme.typography.headlineMedium)
                field(obj, "status")?.let { Text(it) }
                listOf("description", "goal", "summary", "body").forEach { name ->
                    field(obj, name)?.let { MarkdownText(it, open = { raw -> if (displayedFresh) textLink(raw) }) }
                }
            }
            listOf("taskId" to Destination.TASK, "projectId" to Destination.PROJECT,
                "coordinatorSessionId" to Destination.SESSION, "sessionId" to Destination.SESSION).forEach { (key, type) ->
                field(obj, key)?.let { id -> item { TextButton(enabled = displayedFresh, onClick = { open(OrbitRoute(type, id, origin = Origin.LINK)) }) {
                    Text(when (key) { "taskId" -> "Open task"; "projectId" -> "Open project"; "coordinatorSessionId" -> "Open coordinator session"; else -> "Open session" })
                } } }
            }
            if (route.destination == Destination.SESSION) item {
                val session = runCatching { io.orbitd.android.core.protocol.Wire.json.decodeFromJsonElement(DirectorySession.serializer(), obj) }.getOrNull()
                session?.let { TextButton(enabled = displayedFresh && data.fresh, onClick = { action = DirectoryDialog.SessionMenu(it,
                    SessionView.entries.firstOrNull { v -> v.name == it.lifecycleState } ?: SessionView.OPEN) }) { Text("Session options") } }
            }
        }
    }
    action?.let { DirectoryActionDialog(it, api, data.copy(fresh = data.fresh && fresh), { action = it }) { retry++; refresh() } }
}
