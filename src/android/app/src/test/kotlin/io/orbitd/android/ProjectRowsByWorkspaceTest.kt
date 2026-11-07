package io.orbitd.android

import androidx.activity.compose.setContent
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.core.auth.*
import io.orbitd.android.core.net.*
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.directory.*
import io.orbitd.android.navigation.*
import io.orbitd.android.ui.OrbitTheme
import java.time.Instant
import java.util.concurrent.CopyOnWriteArrayList
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.builtins.ListSerializer
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** A project's row only where its coordinator runs (owner 2026-11-07, docs/mocks/project-rows-by-workspace, option A; iOS b6acefcc2), in
 * a workspace's list over two workspaces' sessions: where the coordinator does not run, the project has no row; its members there are
 * rows of their own, in their own time order, their second line led by the project's progress, and their long press opens with Sessions,
 * which opens the project's sessions page. The coordinator's workspace keeps the project's row. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h891dp")
class ProjectRowsByWorkspaceTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val opened = CopyOnWriteArrayList<OrbitRoute>()

    private val prod = "w-prod"
    private val dev = "w-dev"
    private val project = "p-search"
    private val title = "Search moves to the new index"
    private val hint = "Part of $title · open its sessions"
    private fun ago(minutes: Long) = Instant.now().minusSeconds(minutes * 60).toString()
    private fun session(id: String, name: String, workspace: String, minutes: Long, role: String? = "TASK", lifecycle: String = "OPEN") =
        DirectorySession(id, name, status = "AWAITING_INPUT", runState = "AWAITING_INPUT", lifecycleState = lifecycle, workspaceId = workspace,
            lastTurnAt = ago(minutes), createdAt = ago(minutes + 120), lastAssistantText = "The reply of $name.",
            projectMembership = role?.let { SessionProjectMembership(project, title, "OPEN", it) })
    /** The coordinator and one member run in Develop; two members and an ordinary session in Prod. */
    private val open = listOf(session("coord", title, dev, 1, role = "COORDINATOR"), session("shards", "Shard strategy", dev, 3),
        session("check", "Production read-only check", prod, 22), session("deploy", "Production deploy", prod, 41),
        session("cert", "Certificate rotation script", prod, 15, role = null))
    private val sidebar = """[{"id":"$project","title":"$title","status":"OPEN","buckets":{"running":1},
        "taskCounts":{"done":10,"failed":0,"total":12},"attention":{}}]"""

    private fun respond(request: ApiRequest, completed: List<DirectorySession>): ApiResponse {
        val path = request.path.joinToString("/")
        val view = request.query.firstOrNull { it.first == "view" }?.second
        val body = when {
            path == "projects/sidebar" -> sidebar
            path == "sessions" && view == "completed" -> Wire.json.encodeToString(ListSerializer(DirectorySession.serializer()), completed)
            else -> "[]"
        }
        return ApiResponse(200, body.encodeToByteArray())
    }

    private fun show(workspace: String, view: SessionView = SessionView.OPEN, completed: List<DirectorySession> = emptyList()) {
        val auth = (compose.activity.application as OrbitApplication).session
        compose.waitUntil(60_000) { auth.state.value is AuthState.SignedOut }
        runBlocking { auth.login(ServerAddress.parse("https://fixture.test"), "a@example.test", "fixture-password") }
        val handle = (auth.state.value as AuthState.SignedIn).handle
        val api = DirectoryApi(object : OrbitApi {
            override suspend fun request(handle: SessionHandle, request: ApiRequest) = respond(request, completed)
        }, handle)
        val data = DirectoryData(workspaces = listOf(DirectoryWorkspace(prod, "Prod"), DirectoryWorkspace(dev, "Develop")),
            sessions = mapOf("open" to open), ready = true, fresh = true)
        compose.activityRule.scenario.onActivity { activity -> activity.setContent { OrbitTheme {
            DirectoryScreen(OrbitRoute(Destination.WORKSPACE, workspace, workspace, sessionView = view.query), data, api, handle, { opened += it }, {})
        } } }
        compose.waitForIdle()
    }

    private fun exists(matcher: SemanticsMatcher, unmerged: Boolean = false) =
        compose.onAllNodes(matcher, useUnmergedTree = unmerged).fetchSemanticsNodes().isNotEmpty()
    private fun projectRow() = SemanticsMatcher("a project's row") { it.config.getOrNull(SemanticsProperties.TestTag)?.startsWith("project-row:") == true }
    private fun marked(name: String) = hasContentDescription(hint) and hasAnyAncestor(hasRowMenu("Options for $name"))
    /** The list's rows, top to bottom, by the name their long press is offered under. */
    private fun rows() = compose.onAllNodes(hasRowMenu("Options for ", substring = true)).fetchSemanticsNodes()
        .mapNotNull { it.config.getOrNull(SemanticsActions.OnLongClick)?.label?.removePrefix("Options for ") }
    private fun inDialog(text: String) = hasText(text) and hasClickAction() and hasAnyAncestor(isDialog())
    private fun dialogButtons() = compose.onAllNodes(hasAnyAncestor(isDialog()) and hasClickAction()).fetchSemanticsNodes()
        .mapNotNull { node -> node.config.getOrNull(SemanticsProperties.Text)?.firstOrNull()?.text }
    private fun menu(name: String, item: String) {
        compose.onNode(hasRowMenu("Options for $name")).openRowMenu()
        compose.waitUntil(10_000) { exists(inDialog(item)) }
    }

    @Test fun whereTheCoordinatorDoesNotRunItsMembersAreRowsLedByTheProjectsProgress() {
        show(prod)
        // The progress comes with the sidebar's read.
        compose.waitUntil(30_000) { exists(hasText("10/12") and hasAnyAncestor(hasRowMenu("Options for Production deploy")), unmerged = true) }
        compose.onAllNodes(projectRow()).assertCountEquals(0)
        for (name in listOf("Production read-only check", "Production deploy")) {
            compose.onNode(marked(name), useUnmergedTree = true).assertExists()
            compose.onNode(hasText("10/12") and hasAnyAncestor(hasRowMenu("Options for $name")), useUnmergedTree = true).assertExists()
            compose.onNode(hasText("The reply of $name.") and hasAnyAncestor(hasRowMenu("Options for $name")), useUnmergedTree = true).assertExists()
        }
        // The workspace's ordinary session carries no mark, and every row is in its own time order.
        compose.onAllNodes(hasTestTag("project-progress-chip") and hasAnyAncestor(hasRowMenu("Options for Certificate rotation script")),
            useUnmergedTree = true).assertCountEquals(0)
        assertEquals(listOf("Certificate rotation script", "Production read-only check", "Production deploy"), rows())
    }

    @Test fun theCoordinatorsWorkspaceKeepsTheProjectsRow() {
        show(dev)
        compose.waitUntil(30_000) { exists(hasTestTag("project-row:$project")) }
        compose.onAllNodes(hasContentDescription(hint), useUnmergedTree = true).assertCountEquals(0)
        assertEquals(listOf(title), rows())
    }

    @Test fun aMembersLongPressOpensWithSessionsWhichOpensItsProjectsSessions() {
        show(prod)
        menu("Production read-only check", "Sessions")
        // Sessions in a group of its own, then the member's own actions, its own Move… among them.
        assertEquals(listOf("Sessions", "Rename", "Pin", "Tags…", "Complete", "Share…", "Move…", "Move to Trash", "Close"), dialogButtons())
        compose.onNode(inDialog("Sessions")).performClick()
        compose.waitForIdle()
        assertEquals(listOf(OrbitRoute(Destination.PROJECT_SESSIONS, project, prod, origin = Origin.LIST)), opened.toList())
        compose.onAllNodes(isDialog()).assertCountEquals(0)
    }

    @Test fun anOrdinaryRowsLongPressHasNoSessions() {
        show(prod)
        menu("Certificate rotation script", "Rename")
        assertEquals(listOf("Rename", "Pin", "Tags…", "Complete", "Share…", "Move…", "Move to Trash", "Close"), dialogButtons())
    }

    /** Completed follows the same rule, decided by a coordinator still in the Open list. */
    @Test fun completedFollowsTheSameRule() {
        show(prod, SessionView.COMPLETED, completed = listOf(session("smoke", "Production smoke test", prod, 90, lifecycle = "COMPLETED")))
        compose.waitUntil(30_000) { exists(marked("Production smoke test"), unmerged = true) }
        compose.onAllNodes(projectRow()).assertCountEquals(0)
        assertEquals(listOf("Production smoke test"), rows())
    }

    /** A member the list does not mark — its project's row holds it, or the list is flat (Trash, a tag, a search) — offers neither
     * Sessions nor Move…: only the coordinator moves a project's row (A05-6). */
    @Test fun anUnmarkedMembersMenuHasNeitherSessionsNorMove() {
        show(prod)
        compose.activityRule.scenario.onActivity { activity -> activity.setContent { OrbitTheme {
            DirectoryActionDialog(DirectoryDialog.SessionMenu(open[2], SessionView.OPEN), DirectoryApi(object : OrbitApi {
                override suspend fun request(handle: SessionHandle, request: ApiRequest) = ApiResponse(200, "{}".encodeToByteArray())
            }, ((activity.application as OrbitApplication).session.state.value as AuthState.SignedIn).handle),
                DirectoryData(ready = true, fresh = true), {}, onChanged = {})
        } } }
        compose.waitUntil(10_000) { exists(inDialog("Rename")) }
        assertEquals(listOf("Rename", "Pin", "Tags…", "Complete", "Share…", "Move to Trash", "Close"), dialogButtons())
    }
}
