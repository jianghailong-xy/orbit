package io.orbitd.android.navigation

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import io.orbitd.android.OrbitApplication
import io.orbitd.android.core.auth.SessionHandle
import io.orbitd.android.core.cards.text
import io.orbitd.android.directory.DirectoryApi
import io.orbitd.android.directory.DirectoryData
import io.orbitd.android.directory.SessionProjectGrouping
import io.orbitd.android.directory.StatusMessage
import io.orbitd.android.directory.directoryError
import io.orbitd.android.directory.orderedWorkspaces
import io.orbitd.android.projects.CoordinatorPulse
import io.orbitd.android.projects.DrawerMark
import io.orbitd.android.projects.ProjectAttention
import io.orbitd.android.realtime.PagePoll
import io.orbitd.android.realtime.PagePolls
import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.*

/** The drawer's open projects as `GET /projects?status=OPEN` last answered — read as the drawer is composed, then as a page's poll
 * reads ([PagePolls]: on a project's or its tasks' events and each connect, a minute without one, never per session event) — which the
 * Projects row counts from and the project rows are drawn from (iOS `ProjectsModel`, behind both). */
@Stable
class DrawerProjectsState {
    var projects by mutableStateOf<List<JsonObject>>(emptyList())
        internal set
    var error by mutableStateOf<String?>(null)
        internal set
    internal var retry by mutableIntStateOf(0)
}

@Composable
fun rememberDrawerProjects(app: OrbitApplication, handle: SessionHandle, api: DirectoryApi): DrawerProjectsState {
    val state = remember { DrawerProjectsState() }
    PagePoll(app, handle, PagePolls.PROJECT_EVENTS, api, state.retry) {
        try {
            state.projects = api.read(listOf("projects"), JsonArray.serializer(), listOf("status" to "OPEN")).filterIsInstance<JsonObject>()
            state.error = null
        } catch (cancel: CancellationException) { throw cancel }
        catch (failure: Exception) { state.error = directoryError(failure) }
    }
    return state
}

/** A project's root page, a drawer row's and a merge push's (iOS `openProjectSessions(_:inColumn: false)`, 6f5f883c8, 6b4bef713): its
 * sessions page over its coordinator's workspace — or the one [showing], or the first — and its page when there is no workspace to
 * open it over (A05-7). */
fun projectRoot(id: String, data: DirectoryData, showing: String?, origin: Origin): OrbitRoute {
    val coordinator = data.sessions["open"].orEmpty().firstOrNull {
        it.projectMembership?.isCoordinator == true && ObjectId.same(it.projectMembership?.projectId, id)
    }
    val over = coordinator?.workspace ?: showing ?: orderedWorkspaces(data.workspaces).firstOrNull()?.id
    return if (over == null) OrbitRoute(Destination.PROJECT, id, origin = origin)
    else OrbitRoute(Destination.PROJECT_SESSIONS, id, over, origin = origin)
}

/** The drawer's open projects, closing the rail (iOS `CompactShell.projectRows`): the ones waiting on the reader first, then the most
 * recently active, a coordinator's turn in the live session list ([coordinators]) counting as activity ([ProjectAttention.drawerProjects]),
 * under "Projects" and how many there are. Each row is a destination of its own (iOS 6f5f883c8), selected while that destination is
 * showing: [root] is its root page — the project's sessions page, or its page without a workspace to open it over (A05-7). Its mark
 * ([ProjectAttention.drawerMark], iOS `CompactShell.projectRow`): how many things wait on the reader, in amber; with nothing waiting
 * and its work moving, the running spinner — drawn only while the drawer is on screen at all ([live]), as iOS draws it. */
@Composable
fun DrawerProjects(state: DrawerProjectsState, coordinators: Map<String, CoordinatorPulse>, live: Boolean, section: String,
    root: (String) -> OrbitRoute, select: (String, OrbitRoute) -> Unit) {
    val projects = ProjectAttention.drawerProjects(state.projects.filter { it.text("id") != null && it.text("title") != null }, coordinators)
    if (projects.isNotEmpty()) DrawerGroupLabel(DrawerCopy.projects, projects.size)
    state.error?.let { StatusMessage("Couldn't load projects", it, { state.retry++ }) }
    projects.forEach { project ->
        val id = project.text("id") ?: return@forEach
        val title = project.text("title") ?: return@forEach
        val badge: (@Composable () -> Unit)? = when (val mark = ProjectAttention.drawerMark(project, coordinators[SessionProjectGrouping.key(id)])) {
            is DrawerMark.NeedsYou -> ({ NeedsYouCount(mark.count, Modifier.testTag("drawer-project-needs-you:$id")) })
            DrawerMark.Running -> if (live) ({ RunningMark(Modifier.testTag("drawer-project-running:$id")) }) else null
            DrawerMark.Idle -> null
        }
        DrawerRow(section == projectDestination(id), { select(projectDestination(id), root(id)) }, trailing = badge) { DrawerLabel(title) }
    }
}

/** The Projects row's amber number (iOS `CompactShell.projectsRow`): how many projects have something waiting on the reader in person
 * — a merge to confirm, a question, an escalation, a pause, a coordinator asking to start the project or to record it done
 * (`ProjectsModel.needsYouCount`) — and nothing at all when none has; a project that merely went quiet is not counted. Written and
 * said as the Wiki row writes and says its own ([io.orbitd.android.wiki.WikiDrawerCount]), as iOS draws the two alike. */
@Composable
fun ProjectsDrawerCount(state: DrawerProjectsState) {
    val waiting = ProjectAttention.needsYouCount(state.projects)
    if (waiting > 0) Text("$waiting", Modifier.testTag("projects-drawer-count").semantics { contentDescription = DrawerCopy.waitingOnYou(waiting) },
        color = Color(0xFFFF9500), style = MaterialTheme.typography.labelSmall.copy(fontWeight = FontWeight.SemiBold))
}

/** The drawer's words, as iOS says them: a project row's count (`NeedsYouCountCapsule`'s label) and spinner, the Projects row's count
 * (`CompactShell.projectsRow`) and the project rows' group (`AppSection.projects.title`). */
internal object DrawerCopy {
    fun waitingForYou(count: Int) = "$count waiting for you"
    fun waitingOnYou(count: Int) = "$count waiting on you"
    const val running = "Running"
    const val projects = "Projects"
}
