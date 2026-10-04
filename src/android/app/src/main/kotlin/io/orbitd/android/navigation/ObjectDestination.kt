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
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.*

/** The shared route boundary for A06/A07/A11/A12/A13. It resolves real objects already;
 * feature pages replace this overview without changing object identity or its return stack. */
@Composable
fun ObjectDestination(route: OrbitRoute, api: DirectoryApi, data: DirectoryData,
    revision: Long, open: (OrbitRoute) -> Unit, refresh: () -> Unit) {
    var content by remember(route) { mutableStateOf<JsonElement?>(null) }
    var error by remember(route) { mutableStateOf<String?>(null) }
    var loading by remember(route) { mutableStateOf(true) }
    var retry by remember { mutableIntStateOf(0) }
    var action by remember { mutableStateOf<DirectoryDialog?>(null) }
    val path = when (route.destination) {
        Destination.SESSION -> listOf("sessions", route.id!!)
        Destination.TASK -> listOf("tasks", route.id!!)
        Destination.PROJECT -> listOf("projects", route.id!!)
        Destination.WIKI_ENTRY -> listOf("wiki", "entries", route.id!!)
        Destination.WATCH -> listOf("watches", route.id!!)
        Destination.RUNNER -> listOf("runners", route.id!!)
        Destination.PROJECTS -> listOf("projects")
        Destination.TASKS, Destination.LIST -> listOf("tasks")
        Destination.WIKI -> if (route.id == null) listOf("wiki", "spaces") else listOf("wiki", "spaces", route.id, "entries")
        else -> emptyList()
    }
    LaunchedEffect(route, revision, retry) {
        if (path.isEmpty()) { loading = false; return@LaunchedEffect }
        loading = true; error = null
        try { content = api.read(path, JsonElement.serializer(),
            if (route.destination == Destination.LIST) listOf("listId" to route.id!!) else emptyList()) }
        catch (cancel: CancellationException) { throw cancel }
        catch (failure: Exception) { error = directoryError(failure) }
        finally { loading = false }
    }
    fun field(obj: JsonObject, name: String) = (obj[name] as? JsonPrimitive)?.contentOrNull
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        if (loading) item { LoadingMessage("Loading…") }
        error?.let { item { StatusMessage("Couldn't open this item", it, { retry++ }) } }
        if (route.destination == Destination.DRAFT) item {
            Text("New session", style = MaterialTheme.typography.headlineMedium)
            Text(data.workspaces.firstOrNull { ObjectId.same(it.id, route.workspaceId) }?.name ?: "Workspace unavailable")
            route.folderId?.let { id -> Text(data.folders.firstOrNull { ObjectId.same(it.id, id) }?.name ?: "Folder unavailable") }
        }
        val list = (content as? JsonArray)?.filterIsInstance<JsonObject>()
        if (list != null) {
            if (list.isEmpty()) item { StatusMessage("No items yet", "Items from your instance will appear here.") }
            items(list, key = { field(it, "id").orEmpty() }) { obj ->
                val id = field(obj, "id")
                val destination = when (route.destination) {
                    Destination.PROJECTS -> Destination.PROJECT
                    Destination.WIKI -> if (route.id == null) Destination.WIKI else Destination.WIKI_ENTRY
                    else -> Destination.TASK
                }
                ListItem(headlineContent = { Text(field(obj, "title") ?: field(obj, "name") ?: "Untitled") },
                    supportingContent = { field(obj, "status")?.let { Text(it) } },
                    modifier = Modifier.clickable(enabled = id != null, role = Role.Button) { open(OrbitRoute(destination, id)) })
            }
        }
        (content as? JsonObject)?.let { obj ->
            item {
                Text(field(obj, "title") ?: field(obj, "name") ?: route.destination.name.lowercase().replaceFirstChar(Char::uppercase), style = MaterialTheme.typography.headlineMedium)
                field(obj, "status")?.let { Text(it) }
                field(obj, "description")?.let { Text(it) }
                field(obj, "goal")?.let { Text(it) }
            }
            listOf("taskId" to Destination.TASK, "projectId" to Destination.PROJECT,
                "coordinatorSessionId" to Destination.SESSION, "sessionId" to Destination.SESSION).forEach { (key, type) ->
                field(obj, key)?.let { id -> item { TextButton(onClick = { open(OrbitRoute(type, id, origin = Origin.LINK)) }) {
                    Text(when (key) { "taskId" -> "Open task"; "projectId" -> "Open project"; "coordinatorSessionId" -> "Open coordinator session"; else -> "Open session" })
                } } }
            }
            if (route.destination == Destination.SESSION) item {
                val session = runCatching { io.orbitd.android.core.protocol.Wire.json.decodeFromJsonElement(DirectorySession.serializer(), obj) }.getOrNull()
                session?.let { TextButton(onClick = { action = DirectoryDialog.SessionMenu(it,
                    SessionView.entries.firstOrNull { v -> v.name == it.lifecycleState } ?: SessionView.OPEN) }) { Text("Session options") } }
            }
        }
    }
    action?.let { DirectoryActionDialog(it, api, data, { action = it }) { retry++; refresh() } }
}
