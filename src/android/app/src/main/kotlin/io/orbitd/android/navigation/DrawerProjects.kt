package io.orbitd.android.navigation

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationDrawerItem
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import io.orbitd.android.directory.DirectoryApi
import io.orbitd.android.directory.SectionHeading
import io.orbitd.android.directory.StatusMessage
import io.orbitd.android.directory.directoryError
import io.orbitd.android.projects.ProjectAttention
import io.orbitd.android.ui.LocalOrbitColors
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.*

/** The drawer's open projects. Each row is a destination of its own (iOS 6f5f883c8), selected while that destination is showing:
 * [root] is its root page — the project's sessions page, or its page without a workspace to open it over (A05-7). A row whose project
 * has something waiting on the reader carries how many things wait, in amber (iOS `CompactShell.projectRow`). */
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
        val waiting = ProjectAttention.needsYouItemCount(project)
        if (id != null && title != null) NavigationDrawerItem(label = { Text(title) }, selected = section == projectDestination(id),
            onClick = { select(projectDestination(id), root(id)) },
            badge = if (waiting > 0) ({ NeedsYouCount(waiting, Modifier.testTag("drawer-project-needs-you:$id")) }) else null)
    }
}

/** The amber count in a drawer row's trailing slot (iOS `NeedsYouCountCapsule`): how many things under the row wait on you. */
@Composable
internal fun NeedsYouCount(count: Int, modifier: Modifier = Modifier) {
    val amber = LocalOrbitColors.current.needsYou
    Text("$count", modifier.background(amber.copy(alpha = 0.15f), RoundedCornerShape(50)).padding(horizontal = 7.dp, vertical = 2.dp)
        .clearAndSetSemantics { contentDescription = DrawerCopy.waitingForYou(count) },
        color = amber, style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold)
}

/** The drawer's words for a count, as iOS says them (`NeedsYouCountCapsule`'s label). */
internal object DrawerCopy {
    fun waitingForYou(count: Int) = "$count waiting for you"
}
