package io.orbitd.android.navigation

import androidx.compose.material3.NavigationDrawerItem
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import io.orbitd.android.directory.DirectoryApi
import io.orbitd.android.directory.SectionHeading
import io.orbitd.android.directory.StatusMessage
import io.orbitd.android.directory.directoryError
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.*

/** The drawer's open projects. Each row is a destination of its own (iOS 6f5f883c8), selected while that destination is showing:
 * [root] is its root page — the project's sessions page, or its page without a workspace to open it over (A05-7). */
@Composable
fun DrawerProjects(api: DirectoryApi, revision: Long, section: String, root: (String) -> OrbitRoute, select: (String, OrbitRoute) -> Unit) {
    var projects by remember { mutableStateOf<List<JsonObject>>(emptyList()) }
    var error by remember { mutableStateOf<String?>(null) }
    var retry by remember { mutableIntStateOf(0) }
    LaunchedEffect(api, revision, retry) {
        try {
            projects = api.read(listOf("projects"), JsonArray.serializer(), listOf("status" to "OPEN")).filterIsInstance<JsonObject>()
            error = null
        } catch (cancel: CancellationException) { throw cancel }
        catch (failure: Exception) { error = directoryError(failure) }
    }
    if (projects.isNotEmpty()) SectionHeading("Open projects")
    error?.let { StatusMessage("Couldn't load projects", it, { retry++ }) }
    projects.forEach { project ->
        val id = (project["id"] as? JsonPrimitive)?.contentOrNull
        val title = (project["title"] as? JsonPrimitive)?.contentOrNull
        if (id != null && title != null) NavigationDrawerItem(label = { Text(title) }, selected = section == projectDestination(id),
            onClick = { select(projectDestination(id), root(id)) })
    }
}
