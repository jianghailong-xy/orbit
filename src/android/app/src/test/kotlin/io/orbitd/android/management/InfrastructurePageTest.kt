package io.orbitd.android.management

import android.content.ComponentName
import androidx.activity.ComponentActivity
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.lifecycle.Lifecycle
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.OrbitRoute
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * A13-17 (iOS 5e75edbde): Settings' Machines & models group is one row, Infrastructure, whose page reads top to bottom Needs you, What
 * your agents can run on, Machines, Add Runner, Account pools and API keys — each line of Needs you with its way out in the app — and
 * reads the machines again every 15 s while it is up.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ManagementShellApplication::class)
class InfrastructurePageTest {
    @get:Rule(order = 0) val host = object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }
    @get:Rule(order = 1) val compose = createAndroidComposeRule<ComponentActivity>()
    private val fixture = ManagementFixture
    private var revision by mutableLongStateOf(0L)
    private val opened = mutableListOf<OrbitRoute>()

    @Before fun start() { fixture.reset() }

    private fun api(): ManagementApi {
        val session = fixture.session()
        runBlocking { fixture.signIn(session) }
        return ManagementApi(session, (session.state.value as AuthState.SignedIn).handle)
    }
    private fun page() {
        val api = api()
        compose.setContent { InfrastructureSettings(api, revision, null, { opened += it }, {}) }
    }
    private fun await(text: String) = compose.waitUntil(60_000) { compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty() }
    /** Where [text] starts down the page, scrolled out of view or not (boundsInRoot clips to what is on screen). */
    private fun top(text: String) = compose.onNodeWithText(text).fetchSemanticsNode().positionInRoot.y
    private fun runnerReads() = fixture.calls.count { it == "GET runners" }
    /** Moves the test clock on by [ms] in frames: a delay in an effect elapses only when the clock moves. */
    private fun advance(ms: Long) { repeat((ms / 500).toInt()) { compose.mainClock.advanceTimeBy(500); compose.waitForIdle() } }

    /** Codex signed out on the fixture's machine, and Claude Code signed in there. */
    private fun codexSignedOut() {
        fixture.runnerEngines = """[{"engine":"claude","installed":true,"auth":"yes"},{"engine":"codex","installed":true,"auth":"no"}]"""
    }

    @Test fun theFiveSectionsComeInIosOrderWithIosWords() {
        codexSignedOut()
        fixture.providersMine = """[{"id":"${fixture.KEY_OPENAI}","slug":"openai","label":"OpenAI","runtime":"codex","presetSlug":"openai",
            "hasApiKey":true,"enabled":false,"defaultModel":"gpt-5","models":[{"value":"gpt-5","label":"GPT-5"}],"engines":["codex","opencode"]}]"""
        page()
        await(Infrastructure.NEEDS_YOU)
        val sections = listOf(Infrastructure.NEEDS_YOU, Infrastructure.MACHINES, RunnerCopy.ADD, Infrastructure.ACCOUNT_POOLS,
            Infrastructure.API_KEYS)
        sections.forEach { compose.onAllNodesWithText(it).assertCountEquals(1) }
        val tops = sections.map(::top)
        assertEquals("top to bottom: $sections", tops.sorted(), tops)
        // Each block's words, as iOS says them.
        listOf(Infrastructure.MACHINES_DETAIL, RunnerCopy.ADD_FOOTER, Infrastructure.ACCOUNT_POOLS_DETAIL,
            "${Infrastructure.API_KEYS_DETAIL} ${DeepSeekBalance.EDIT_ON_WEB}").forEach { compose.onNodeWithText(it).assertExists() }
        compose.onNodeWithText("1 machine · 0 / 2 slots busy").assertExists()
        // The machine's row: its slots and its engine signed out, Needs you's rule.
        compose.onNodeWithText("0 / 2 running · 1 engine signed out", useUnmergedTree = true).assertExists()
        // A key switched off says so, beside its model and the engines it runs on.
        compose.onNodeWithText("GPT-5", useUnmergedTree = true).assertExists()
        compose.onNodeWithText(Infrastructure.DISABLED, useUnmergedTree = true).assertExists()
        compose.onNodeWithText("Codex · OpenCode", useUnmergedTree = true).assertExists()
        // The old pages' words are gone with them.
        listOf("On your runners", "Your API keys", "Providers").forEach { compose.onAllNodesWithText(it, substring = true).assertCountEquals(0) }
    }

    @Test fun eachLineOfNeedsYouOpensItsWayOutInTheApp() {
        codexSignedOut()
        fixture.secondRunner = true; fixture.runnerTwoOnline = false
        // The pool's people couldn't be read, so its own account — signed out — is all it has.
        fixture.loginState = "SIGNED_OUT"; fixture.accessFails = true
        page()
        await("Codex is signed out on Old alias")
        compose.onNodeWithText("Spare box is offline").assertExists()
        compose.onNodeWithText("Last seen 1d ago · its subscriptions are unavailable until it’s back").assertExists()
        compose.onNodeWithText("Team Codex is unavailable").assertExists()
        compose.onNodeWithText("Signed out · no session can start on it").assertExists()
        compose.onNodeWithText(Infrastructure.SIGNED_OUT_DETAIL).assertExists()
        fun press(line: String, action: String) = compose.onNode(hasText(action) and hasClickAction() and
            hasAnyAncestor(hasTestTag(line))).performScrollTo().performClick()
        press("needs-you:out:${fixture.RUNNER}/codex", Infrastructure.SIGN_IN)
        press("needs-you:offline:${fixture.RUNNER_TWO}", Infrastructure.DETAILS)
        press("needs-you:pool:${fixture.POOL}", Infrastructure.MANAGE)
        compose.runOnIdle {
            assertEquals(listOf(OrbitRoute(Destination.RUNNER, fixture.RUNNER, recordId = "engine:codex"), OrbitRoute(Destination.RUNNER, fixture.RUNNER_TWO),
                OrbitRoute(Destination.SETTINGS, "infrastructure", recordId = "own:${fixture.POOL}")), opened)
        }
    }

    /** The machines are read again every 15 s while the page is in front — what needs you moves with them — and not while the app is in
     * the background. */
    @Test fun theMachinesAreReadAgainEvery15sWhileThePageIsUp() {
        fixture.secondRunner = true
        page()
        await("Spare box")
        compose.waitForIdle()
        val first = runnerReads()
        fixture.runnerTwoOnline = false
        advance(14_000)
        assertEquals("not before 15 s", first, runnerReads())
        compose.onAllNodesWithText("Spare box is offline").assertCountEquals(0)
        advance(1_500)
        compose.waitUntil(60_000) { runnerReads() == first + 1 }
        await("Spare box is offline")
        advance(15_000)
        compose.waitUntil(60_000) { runnerReads() == first + 2 }
        // In the background nothing is read; back in front, the page reads at once and keeps the pace.
        compose.activityRule.scenario.moveToState(Lifecycle.State.STARTED)
        compose.waitForIdle()
        val paused = runnerReads()
        advance(45_000)
        assertEquals("no reads while the app is in the background", paused, runnerReads())
        compose.activityRule.scenario.moveToState(Lifecycle.State.RESUMED)
        compose.waitUntil(60_000) { runnerReads() == paused + 1 }
    }

    /** Settings' Machines & models group: one row, Machines & models, and no header over it to say the name twice (iOS SettingsHome,
     * docs/mocks/machines-and-models ⑥-2) — "1 needs you" while something does, else the machines online — and the page's line under it.
     * It comes first, before Preferences, whose first row is Sessions (docs/mocks/ios-settings-order). */
    @Test fun settingsHasOneInfrastructureRowWithItsValueAndTheLineUnderIt() {
        val api = api()
        compose.setContent {
            SettingsScreen(api, OrbitRoute(Destination.SETTINGS), revision, { opened += it }, {}, logout = {}, changed = {}, workspaceDeleted = {},
                deviceAlerts = { true }, notifications = {}, about = {})
        }
        await("1 of 1 online")
        compose.onNode(hasText(Infrastructure.TITLE) and hasText("1 of 1 online") and hasClickAction()).assertExists()
        compose.onNodeWithText(Infrastructure.SUBTITLE).assertExists()
        listOf("Runners", "Providers").forEach { compose.onAllNodesWithText(it).assertCountEquals(0) }
        compose.onAllNodesWithText(Infrastructure.TITLE).assertCountEquals(1)
        assertTrue("Machines & models comes before Preferences", top(Infrastructure.TITLE) < top(Infrastructure.SUBTITLE) &&
            top(Infrastructure.SUBTITLE) < top("Preferences") && top("Preferences") < top(SESSIONS) && top(SESSIONS) < top("Notifications"))
        codexSignedOut()
        revision++
        await("1 needs you")
        compose.onNode(hasText(Infrastructure.TITLE) and hasText("1 needs you") and hasClickAction()).performScrollTo().performClick()
        compose.runOnIdle { assertEquals(listOf(OrbitRoute(Destination.SETTINGS, "infrastructure")), opened) }
    }

    /** A pool's page and a DeepSeek key's are titled by their name once read, as iOS titles them; Infrastructure until then. */
    @Test fun aPoolsPageIsTitledByItsName() {
        assertEquals(Infrastructure.TITLE, settingsTitle("infrastructure"))
        assertEquals(Infrastructure.TITLE, settingsTitle("infrastructure", "shared:never-read"))
        val api = api()
        compose.setContent { InfrastructureSettings(api, revision, "own:${fixture.POOL}", {}, {}) }
        await("Team Codex")
        assertEquals("Team Codex", settingsTitle("infrastructure", "own:${fixture.POOL}"))
        assertEquals(Infrastructure.TITLE, runnerTitle(null, null, null))
    }
}
