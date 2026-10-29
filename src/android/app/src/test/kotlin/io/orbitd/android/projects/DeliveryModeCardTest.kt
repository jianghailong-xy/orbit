package io.orbitd.android.projects

import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.SideEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.ui.OrbitTheme
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.time.Instant

/** The Delivery row as the owner meets it (§10.5 O-L1/O-L2, the browser's `StartProjectCard` and `ProjectRunSettings`): on the start
 * card under the main branch, its menu offering both ways with what each means, the agent's way only on a main line — the Automatic
 * sentence and Comes to you following it, and a line moved off main taking it back to Orbit's — and no row where the read says no
 * mode; in How it runs, each way writing at once, a started line still taking it, the agent's way drawn and not offered off a main
 * line, and the line's and Automatic's own words while the agent pushes. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class)
class DeliveryModeCardTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val project = "34noHniU4wmCRkZJkR6df"
    private val seal = "d".repeat(64)
    private val tag = "start-card"
    private val now = Instant.parse("2026-10-29T03:00:00Z")
    private fun j(text: String) = Json.parseToJsonElement(text).jsonObject

    /** acme/payments-api on [line], its way [mode] — none for a server that predates the choice. */
    private fun view(mode: String?, line: String? = "MAIN", locked: Boolean = false) = buildJsonObject {
        put("line", line?.let(::JsonPrimitive) ?: JsonNull); put("ref", if (line == "PROJECT_BRANCH") "project/$project" else "main")
        put("locked", locked); put("escalationSeconds", 7200); put("upstreamRef", "main"); put("upstreamChosenAt", JsonNull)
        put("repository", "acme/payments-api"); put("mergeCheckCommand", "make test"); put("branches", JsonNull); put("lastMainBranch", JsonNull)
        put("startedAt", if (locked) JsonPrimitive("2026-10-27T12:00:00Z") else JsonNull)
        mode?.let { put("deliveryMode", it) }
    }
    private fun request(line: String) = StartProjectCopy.Request(StartProjectCopy.Settings(line, "refs/heads/project/$project", true, 2, "make test"), "", seal)

    /** The draft the card last drew. */
    private var drawn: StartProjectCopy.Draft? = null
    private fun card(request: StartProjectCopy.Request, view: JsonObject) {
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme(darkTheme = false) {
            var draft by remember(request, view) { mutableStateOf(StartProjectCopy.Draft.of(request.settings, view)) }
            SideEffect { drawn = draft }
            Column(Modifier.verticalScroll(rememberScrollState())) {
                StartProjectCard(project, "Landing observation", asked = false, askedAgo = null, request = request,
                    criteria = listOf(StartCriterion(1, "Finished work is recorded as landed once it is seen on main.")),
                    plan = StartProjectCopy.PlanView(1, null), hasCoordinator = true, escalationSeconds = 7_200, draft = draft, onDraft = { draft = it },
                    standing = StartProjectCopy.Standing.LIVE, enabled = true, starting = false, error = null, tag = tag, startTag = "$tag-confirm",
                    onStart = {}, onViewTasks = {})
            }
        } } }
        compose.waitForIdle()
    }

    private fun shows(text: String) = compose.onNodeWithText(text).performScrollTo().assertIsDisplayed()

    @Test fun theStartCardOffersTheAgentsWayOnAMainLineAndFollowsIt() {
        card(request("MAIN"), view("PLATFORM"))
        compose.onNodeWithTag("$tag-delivery").performScrollTo().assertIsEnabled().assertTextEquals("${RunSettings.deliveryPlatform} ▾")
        compose.onNodeWithTag("$tag-delivery-hint").assertTextEquals(RunSettings.deliveryPlatformHint("main"))
        compose.onNodeWithTag("$tag-automatic-says").assertTextEquals(RunSettings.automaticSays(true, "MAIN", true, "main"))
        shows("Each merge into main")
        // The menu: both ways, each with what it means, the chosen one ticked.
        compose.onNodeWithTag("$tag-delivery").performClick()
        compose.onNodeWithTag("$tag-delivery:PLATFORM").assert(hasText("✓ ${RunSettings.deliveryPlatform}")).assert(hasText(RunSettings.deliveryPlatformHint("main")))
        compose.onNodeWithTag("$tag-delivery:AGENT_PUSH").assert(hasText(RunSettings.deliveryAgentPush)).assert(hasText(RunSettings.deliveryAgentPushHint("main")))
        compose.onNodeWithTag("$tag-delivery:AGENT_PUSH").performClick()
        compose.waitForIdle()
        assertEquals("AGENT_PUSH", drawn?.deliveryMode)
        compose.onNodeWithTag("$tag-delivery").assertTextEquals("${RunSettings.deliveryAgentPush} ▾")
        compose.onNodeWithTag("$tag-delivery-hint").assertTextEquals(RunSettings.deliveryAgentPushHint("main"))
        // No merge into main asks anybody now: the sentence under the switch says who pushes, and Comes to you has no merge.
        compose.onNodeWithTag("$tag-automatic-says").assertTextEquals(RunSettings.automaticSaysAgentPush(true, "main"))
        compose.onNodeWithText("Each merge into main").assertDoesNotExist()
        compose.onNode(hasText("Any change to the criteria") and hasAnyAncestor(hasTestTag("$tag-comes-to-you")), useUnmergedTree = true).assertExists()
        // A line moved off main takes the way back to Orbit's, and the agent's is no longer offered.
        compose.onNodeWithTag("$tag-line").performScrollTo().performClick()
        compose.onNodeWithTag("$tag-line:PROJECT_BRANCH").performClick()
        compose.waitForIdle()
        assertEquals("PLATFORM", drawn?.deliveryMode)
        compose.onNodeWithTag("$tag-delivery").performScrollTo().assertIsNotEnabled().assertTextEquals("${RunSettings.deliveryPlatform} ▾")
        compose.onNodeWithTag("$tag-delivery-hint").assertTextEquals(RunSettings.deliveryNeedsMainLine("main"))
    }

    @Test fun onAProjectBranchTheAgentsWayIsDrawnAndNotOffered() {
        card(request("PROJECT_BRANCH"), view("PLATFORM", line = null))
        compose.onNodeWithTag("$tag-delivery").performScrollTo().assertIsNotEnabled().assertTextEquals("${RunSettings.deliveryPlatform} ▾")
        compose.onNodeWithTag("$tag-delivery-hint").assertTextEquals(RunSettings.deliveryNeedsMainLine("main"))
        compose.onNodeWithTag("$tag-automatic-says").assertTextEquals(RunSettings.automaticSays(true, "PROJECT_BRANCH", true, "main"))
    }

    @Test fun aReadThatSaysNoModeDrawsNoDeliveryRow() {
        card(request("MAIN"), view(null))
        compose.onNodeWithTag("$tag-delivery").assertDoesNotExist()
        compose.onNodeWithTag("$tag-automatic-says").assertTextEquals(RunSettings.automaticSays(true, "MAIN", true, "main"))
    }

    // MARK: How it runs

    private val writes = mutableListOf<JsonObject?>()
    private fun runSettings(view: JsonObject) {
        val state = ProjectPageState().apply { integration = view }
        val doc = j("""{"id":"$project","coordinatorEnabled":true,"configRevision":"3","maxConcurrentTasks":2,"pausedAt":null}""")
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme(darkTheme = false) {
            Column(Modifier.verticalScroll(rememberScrollState())) {
                RunSettingsSection(state, doc, now, enabled = true, editMergeCheck = {}, integration = { writes += it }, automatic = {}, stepConcurrency = {}, pause = {})
            }
        } } }
        compose.waitForIdle()
    }

    @Test fun howItRunsWritesTheWayAtOnceAndOnlyAMainLineOffersTheAgents() {
        runSettings(view("PLATFORM"))
        compose.onNodeWithTag("project-delivery").performScrollTo()
        compose.onNodeWithTag("project-delivery:PLATFORM").assert(hasText(RunSettings.deliveryPlatform)).assert(hasText(RunSettings.deliveryPlatformHint("main")))
        compose.onNodeWithTag("project-delivery:AGENT_PUSH").assertIsEnabled().assert(hasText(RunSettings.deliveryAgentPushHint("main"))).performClick()
        assertEquals(listOf(j("""{"deliveryMode":"AGENT_PUSH"}""")), writes.filterNotNull())
        shows(RunSettings.lineMainHint("main")); shows(RunSettings.automaticHint("MAIN", "main"))

        // While the agent pushes, the line's and Automatic's own words; moving the line off main takes the way back in the same write.
        writes.clear()
        runSettings(view("AGENT_PUSH"))
        shows(RunSettings.lineMainHintAgentPush("main")); shows(RunSettings.automaticHintAgentPush("main"))
        compose.onNodeWithText(RunSettings.lineMainHint("main")).assertDoesNotExist()
        compose.onNodeWithTag("project-line:PROJECT_BRANCH").performScrollTo().performClick()
        assertEquals(listOf(j("""{"line":"PROJECT_BRANCH","deliveryMode":"PLATFORM"}""")), writes.filterNotNull())

        // A started line still takes it: the way does not lock with the line.
        writes.clear()
        runSettings(view("PLATFORM", locked = true))
        compose.onNodeWithTag("project-delivery:AGENT_PUSH").performScrollTo().assertIsEnabled().performClick()
        assertEquals(listOf(j("""{"deliveryMode":"AGENT_PUSH"}""")), writes.filterNotNull())
    }

    @Test fun offAMainLineTheAgentsWayIsDrawnAndNotOfferedAndAnOlderServerDrawsNoRow() {
        runSettings(view("PLATFORM", line = "PROJECT_BRANCH"))
        compose.onNodeWithTag("project-delivery:AGENT_PUSH").performScrollTo().assertIsNotEnabled()
            .assert(hasText(RunSettings.deliveryAgentPush)).assert(hasText(RunSettings.deliveryNeedsMainLine("main")))
        compose.onNodeWithTag("project-delivery:AGENT_PUSH").performClick()
        compose.onNodeWithTag("project-delivery:PLATFORM").performClick()
        assertTrue("neither writes: one is not offered, the other is the way already", writes.filterNotNull().isEmpty())
        runSettings(view("PLATFORM", line = null))
        compose.onNodeWithTag("project-delivery:AGENT_PUSH").performScrollTo().assertIsNotEnabled()
        runSettings(view(null))
        compose.onNodeWithTag("project-delivery").assertDoesNotExist()
    }
}
