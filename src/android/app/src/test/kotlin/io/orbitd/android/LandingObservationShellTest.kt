package io.orbitd.android

import android.content.Intent
import android.net.Uri
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.cards.ExceptionCards
import io.orbitd.android.projects.ProjectPage
import java.time.Instant
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.setMain
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TestWatcher
import org.junit.runner.Description
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Revision 29 in the production shell (§10.7–§10.9): the project page's Open items say what is handling each item — an observation
 * of main, in its own words — and its task rows wait to be seen on main; in the coordinator conversation, Accept and Observe again go
 * out through the owner's own doors with what each takes. The server is ProjectShell's; the items are the web evidence rig's. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ProjectShellApplication::class, qualifiers = "w411dp-h1800dp")
@OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
class LandingObservationShellTest {
    @get:Rule(order = 0)
    val mainDispatcher = object : TestWatcher() {
        override fun starting(description: Description) { Dispatchers.setMain(UnconfinedTestDispatcher()) }
        override fun finished(description: Description) { Dispatchers.resetMain() }
    }
    @get:Rule(order = 1)
    val compose = createAndroidComposeRule<MainActivity>()

    @Before fun start() = ProjectShell.reset()

    private val launch = ProjectShell.LAUNCH

    @Test fun theOpenItemsSayWhatIsHandlingThemAndTheTaskRowsWaitToBeSeen() {
        ProjectShell.needsYouItems = "[${LandingObservationItems.unobservedOwner()},${LandingObservationItems.landed()}]"
        ProjectShell.holder = "${LandingObservationItems.unobserved()},${LandingObservationItems.observeFailing()}"
        ProjectShell.tasks = LandingObservationItems.tasks()
        openProjectPage()
        compose.onNodeWithTag("project-open-items").performClick()
        await { exists(hasTestTag("open-item:${LandingObservationItems.LANDED}")) }
        fun says(item: String, text: String, substring: Boolean = false) =
            compose.onNode(hasText(text, substring) and hasAnyAncestor(hasTestTag("open-item:$item")), useUnmergedTree = true).assertExists()
        says(LandingObservationItems.LANDED, "Reached main without your confirmation: Fix the login redirect")
        says(LandingObservationItems.LANDED, "7d3e9b01c2a4 is on main · seen by Orbit")
        // Accept is answered on its card: the row's press is the one this page carries out, as the browser's row is.
        compose.onNodeWithTag("open-item:${LandingObservationItems.LANDED}:action").assertTextEquals(ExceptionCards.openTaskSession)
        compose.onAllNodesWithTag("open-item:${LandingObservationItems.LANDED}:handling", useUnmergedTree = true).assertCountEquals(0)
        compose.onNode(hasText(ExceptionCards.handlingLabel) and hasAnyAncestor(hasTestTag("open-item:${LandingObservationItems.UNOBSERVED_OWNER}:handling")),
            useUnmergedTree = true).assertExists()
        // How long ago it was asked moves with the clock: ExceptionCardsTest holds those words.
        says(LandingObservationItems.UNOBSERVED_OWNER, "Observing main… — running · asked ", substring = true)
        says(LandingObservationItems.UNOBSERVED, "Observing main… — queued · asked ", substring = true)
        says(LandingObservationItems.OBSERVE_FAILING, "Integration error: observing main")
        compose.onAllNodesWithTag("open-item:${LandingObservationItems.OBSERVE_FAILING}:action").assertCountEquals(0)
        compose.onNodeWithTag("project-open-items-subtitle").assertTextEquals("2 items need you · 2 with the coordinator")
        compose.onNodeWithText(ProjectPage.withCoordinatorGroup.uppercase()).assertExists()

        // The task rows (§10.9): not seen is not landed — two wait in Pending landing, one landed.
        compose.onNodeWithTag("project-open-items-close").performClick()
        await { !exists(hasTestTag("project-open-items-sheet")) }
        await { runCatching { compose.onNodeWithTag("project-detail").performScrollToNode(hasText("PENDING LANDING")) }.isSuccess }
        compose.onNode(hasText("Waiting to be seen on main · 9f1c2ab") and hasAnyAncestor(hasTestTag("project-task:o1")), useUnmergedTree = true).assertExists()
        compose.onNode(hasText("Waiting to be seen on main") and hasAnyAncestor(hasTestTag("project-task:o2")), useUnmergedTree = true).assertExists()
        scrollTo("project-task:o3")
        compose.onNode(hasText("On main") and hasAnyAncestor(hasTestTag("project-task:o3")), useUnmergedTree = true).assertExists()
        assertTrue("and the seen one is in Landed", exists(hasText("LANDED")))
    }

    @Test fun theCoordinatorsCardsAcceptAndObserveThroughTheOwnersDoors() {
        ProjectShell.needsYouItems = "[${LandingObservationItems.landed()},${LandingObservationItems.unobservedOwner()}]"
        openConversation()
        val landed = "item:${LandingObservationItems.LANDED}"
        await { exists(hasTestTag("$landed:ACCEPT")) }
        compose.onNodeWithTag("$landed:title", useUnmergedTree = true).assertTextEquals(ExceptionCards.landedTitle)
        compose.onNodeWithTag("$landed:ACCEPT").performScrollTo().performClick()
        await { exists(hasText("Request accepted", substring = true) and hasAnyAncestor(hasTestTag(landed)), unmerged = true) }
        assertTrue(ProjectShell.calls.contains("POST projects/$launch/open-items/${LandingObservationItems.LANDED}/accept"))

        val unobserved = "item:${LandingObservationItems.UNOBSERVED_OWNER}"
        compose.onNode(hasText("Observing main… — running · asked ", substring = true) and hasAnyAncestor(hasTestTag("$unobserved:fact:Handling")),
            useUnmergedTree = true).assertExists()
        compose.onNodeWithTag("$unobserved:OBSERVE").performScrollTo().performClick()
        compose.onNodeWithTag("$unobserved:observe-reason").performScrollTo().performTextInput("  The runner can reach the repository again  ")
        compose.onNodeWithTag("$unobserved:observe-confirm").performScrollTo().performClick()
        await { exists(hasText("Request accepted", substring = true) and hasAnyAncestor(hasTestTag(unobserved)), unmerged = true) }
        assertTrue(ProjectShell.calls.contains("POST projects/$launch/integration/observe"))
        assertEquals("""{"reason":"The runner can reach the repository again"}""", ProjectShell.bodies["POST projects/$launch/integration/observe"])
    }

    // MARK: helpers

    private fun openConversation() {
        signIn()
        await { exists(hasTestTag("workspace:${ProjectShell.ALPHA}")) }
        compose.onNodeWithTag("workspace:${ProjectShell.ALPHA}").performClick()
        await { exists(hasTestTag("project-row:$launch")) }
        compose.onNodeWithTag("project-row:$launch").performClick()
        await { exists(hasTestTag("project-sessions")) && exists(hasText("Coordinate launch") and hasClickAction()) }
        compose.onNode(hasText("Coordinate launch") and hasClickAction()).performClick()
    }
    private fun openProjectPage() {
        signIn(); open("orbit-project:$launch")
        await { exists(hasTestTag("project-detail")) && exists(hasTestTag("project-open-items")) }
    }
    private fun scrollTo(tag: String) = await { runCatching { compose.onNodeWithTag("project-detail").performScrollToNode(hasTestTag(tag)) }.isSuccess }
    private fun app() = compose.activity.application as OrbitApplication
    private fun signIn() {
        compose.waitUntil(60_000) { app().session.state.value is AuthState.SignedOut }
        app().realtime.setNetwork(true, "fixture")
        runBlocking { ProjectShell.signIn(app().session) }
        compose.waitUntil(60_000) { app().session.state.value is AuthState.SignedIn && app().realtime.state.value.directoryFresh }
    }
    private fun open(link: String) {
        compose.activityRule.scenario.onActivity {
            val launch = it.intent
            MainActivity::class.java.getDeclaredMethod("onNewIntent", Intent::class.java).apply { isAccessible = true }
                .invoke(it, Intent(Intent.ACTION_VIEW, Uri.parse(link)).setClass(it, MainActivity::class.java))
            it.intent = launch
        }
        compose.waitForIdle()
    }
    private fun exists(matcher: SemanticsMatcher, unmerged: Boolean = false) = compose.onAllNodes(matcher, unmerged).fetchSemanticsNodes().isNotEmpty()
    private fun await(condition: () -> Boolean) = compose.waitUntil(60_000, condition)
}

/** The web evidence rig's revision-29 items and task rows (docs/evidence/landing-observation/web/rig/capture.mjs), as the open-items
 * and task-page reads carry them, aged from now. */
internal object LandingObservationItems {
    const val UNOBSERVED = "34R29ItemUnobserved001"
    const val UNOBSERVED_OWNER = "34R29ItemUnobservedOwn2"
    const val OBSERVE_FAILING = "34R29ItemObserveFail003"
    const val LANDED = "34R29ItemLanded00000004"
    private const val REQUIRED_UNOBSERVED = "This task’s work is not on main yet — record the commit that carries it, or send the task back to push it."

    private fun ago(minutes: Long) = Instant.now().minusSeconds(minutes * 60).toString()
    private fun from(minutes: Long) = Instant.now().plusSeconds(minutes * 60).toString()
    private fun q(value: String?) = value?.let { "\"$it\"" } ?: "null"

    private fun item(id: String, kind: String, title: String, detail: String, assignee: String, reason: String, waited: Long, actions: List<String>,
        primary: String?, required: String, escalated: Long? = null, escalateIn: Long? = null, taskId: String? = null, sessionId: String? = null,
        delivered: Boolean = true, handling: String = "null", facts: String = "null") =
        """{"itemId":"$id","kind":"$kind","title":"$title","detailLine":"$detail","assignee":"$assignee","assigneeReason":"$reason",
            "waitingSince":"${ago(waited)}","escalatedAt":${q(escalated?.let(::ago))},"escalateAt":${q(escalateIn?.let(::from))},
            "taskId":${q(taskId)},"sessionId":${q(sessionId)},"promotionId":null,"fuseEpisodeId":null,
            "delivery":{"state":"${if (delivered) "DELIVERED" else "NOT_REQUIRED"}","sessionId":"${ProjectShell.COORD}","at":null},
            "actions":[${actions.joinToString(",") { "\"$it\"" }}],"primaryAction":${q(primary)},"requiredAction":"$required",
            "question":null,"facts":$facts,"handling":$handling,"outcome":null}"""

    private fun observing(reason: String, minutes: Long, state: String, generation: Int, userId: String?) =
        """{"sessionId":${q(if (userId == null) ProjectShell.COORD else null)},"userId":${q(userId)},"reason":"$reason","startedAt":"${ago(minutes)}",
            "jobId":"j-observe-$generation","jobKind":"OBSERVE_LANDING","generation":$generation,"state":"$state"}"""

    /** Work its agent pushed that the observation could not find on main (§10.7, the coordinator's), an observation it asked for queued. */
    fun unobserved() = item(UNOBSERVED, "LANDING_UNOBSERVED", "Not on main yet: Ship the delivery mode picker",
        "Its changes are there as other commits · delivered 9f1c2ab7e4d0", "COORDINATOR", "DEFAULT", 25,
        listOf("OPEN_COORDINATOR", "OPEN_TASK_SESSION", "OBSERVE", "CANCEL_TASK"), "OPEN_TASK_SESSION", REQUIRED_UNOBSERVED, escalateIn = 95,
        taskId = "t-picker", sessionId = "s-picker", handling = observing("its agent says it pushed again after the rebase", 4, "QUEUED", 4, null))

    /** The same kind, handed to the owner, with the observation the owner asked for running (§10.8, §4.7 H1). */
    fun unobservedOwner() = item(UNOBSERVED_OWNER, "LANDING_UNOBSERVED", "Not on main yet: Draw the observation cards",
        "Its commit was not found on the line · delivered 3b7e0d91a6c2", "OWNER", "HANDED_OVER", 70,
        listOf("ASK_COORDINATOR_AGAIN", "OPEN_TASK_SESSION", "OBSERVE", "CANCEL_TASK"), "ASK_COORDINATOR_AGAIN", REQUIRED_UNOBSERVED, escalated = 9,
        taskId = "t-cards", sessionId = "s-cards", handling = observing("I pushed the rebased commit to main by hand", 2, "RUNNING", 3, "owner"))

    /** The project's observations failing three times running (§10.6 O-J4): about the line, no task. */
    fun observeFailing(assignee: String = "COORDINATOR") = item(OBSERVE_FAILING, "INTEGRATION_ERROR", "Integration error: observing main", "",
        assignee, if (assignee == "OWNER") "ESCALATED" else "DEFAULT", 40, listOf("OBSERVE"), "OBSERVE",
        "Finished work is not recorded as landed until an observation of main succeeds — let a runner reach the repository, then look again.",
        escalated = if (assignee == "OWNER") 2 else null, escalateIn = if (assignee == "OWNER") null else 80,
        facts = """{"task":null,"targetRef":"main","targetSha":null,"files":[],"nothingLanded":false,"check":null,"branchUnchanged":false,
            "errorCode":"FETCH_FAILED","failure":null}""")

    /** Work that reached main without the owner's confirmation, in a PLATFORM project (§10.7, O-R3): the owner's from birth. */
    fun landed() = item(LANDED, "LANDED_WITHOUT_CONFIRMATION", "Reached main without your confirmation: Fix the login redirect",
        "7d3e9b01c2a4 is on main · seen by Orbit", "OWNER", "DEFAULT", 120, listOf("ACCEPT", "OPEN_TASK_SESSION"), "ACCEPT",
        "This work reached main without your confirmation — accept it, or use Chat about this to have the coordinator file a task that reverts it.",
        taskId = "t-login", sessionId = "s-login", delivered = false)

    /** The task rows (§10.9): two pushed by their agents and not seen yet — one frozen, one still moving — one seen, and one waiting. */
    fun tasks(): String {
        fun task(id: String, title: String, integration: String, extra: String = """"status":"DONE","workState":"DONE","dependencyState":"READY"""") =
            """{"id":"$id","title":"$title",$extra,"integration":$integration}"""
        fun state(state: String, sha: String? = null) = """{"state":"$state","since":"${ago(12)}","handler":null,"openItemId":null,"jobId":null,
            "checksRunningForMs":null,"landTask":null,"mainBranch":"main"${if (state == "AWAITING_OBSERVATION") ""","deliveredSha":${q(sha)}""" else ""}}"""
        return listOf(
            task("o1", "Ship the delivery mode picker", state("AWAITING_OBSERVATION", "9f1c2ab7e4d0b5a6c3f8e1d2a7b4c9e0f1a2b3c4")),
            task("o2", "Draw the observation cards", state("AWAITING_OBSERVATION")),
            task("o3", "Fix the login redirect", state("ON_UPSTREAM")),
            task("o4", "Pay with a saved card", state("NOT_APPLICABLE"),
                """"status":"OPEN","workState":"BLOCKED","dependencyState":"BLOCKED","topoLevel":1,"landingWaitCount":1"""),
        ).joinToString(",", "[", "]")
    }
}
