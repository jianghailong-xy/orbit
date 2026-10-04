package io.orbitd.android.projects

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.cards.*
import io.orbitd.android.directory.DirectoryApi
import io.orbitd.android.directory.directoryError
import io.orbitd.android.navigation.*
import io.orbitd.android.text.MarkdownText
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.*

/** Projects retain the host's object stack, session identity and invalidation stream. */
@Composable
fun ProjectsScreen(app: OrbitApplication, handle: SessionHandle, route: OrbitRoute,
    revision: Long, open: (OrbitRoute) -> Unit) {
    val api = remember(handle) { DirectoryApi(app.session, handle) }
    var value by remember(handle, route.id) { mutableStateOf<JsonElement?>(null) }
    var loading by remember(handle, route.id) { mutableStateOf(true) }
    var error by remember(handle, route.id) { mutableStateOf<String?>(null) }
    var retry by remember(handle, route.id) { mutableIntStateOf(0) }
    LaunchedEffect(handle, route.id, revision, retry) {
        loading = true
        error = null
        try { value = api.read(listOfNotNull("projects", route.id), JsonElement.serializer()) }
        catch (cancel: CancellationException) { throw cancel }
        catch (failure: Exception) { value = null; error = directoryError(failure) }
        finally { loading = false }
    }
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        item { Text(if (route.id == null) "Projects" else "Project", style = MaterialTheme.typography.headlineMedium) }
        if (loading) item { CircularProgressIndicator() }
        error?.let { message -> item { Text(message); TextButton(onClick = { retry++ }) { Text("Retry") } } }
        val rows = (value as? JsonArray)?.filterIsInstance<JsonObject>()
        if (rows != null) {
            if (rows.isEmpty()) item { Text("No projects yet. Ask an agent in a session to start a project.") }
            items(rows, key = { it.text("id").orEmpty() }) { row ->
                ListItem(headlineContent = { Text(row.text("title") ?: "Project") },
                    supportingContent = { Text(row.text("status").orEmpty()) },
                    modifier = Modifier.clickable { row.text("id")?.let { open(OrbitRoute(Destination.PROJECT, it)) } })
            }
        }
        (value as? JsonObject)?.let { project ->
            item { Text(project.text("title").orEmpty(), style = MaterialTheme.typography.titleLarge) }
            project.text("goal")?.let { goal -> item { MarkdownText(goal, open = { OrbitLinks.parse(it)?.let(open) }) } }
            project.text("coordinatorSessionId")?.let { session -> item {
                TextButton(onClick = { open(OrbitRoute(Destination.SESSION, session)) }) { Text("Open coordinator session") }
            } }
        }
    }
}
