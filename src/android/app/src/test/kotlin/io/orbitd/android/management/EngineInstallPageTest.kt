package io.orbitd.android.management

import android.content.ComponentName
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.core.auth.AuthState
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
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
 * A13-17 with A07-15 ② (iOS 5e75edbde, RunnerEnginePage's `installSection`): a runner's engine page installs an engine the machine
 * lacks — OpenCode among them, where the composer's "Not installed →" lands — with Install, or Retry after an install that failed, and
 * Installing… with the relay's own words while one runs.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ManagementShellApplication::class)
class EngineInstallPageTest {
    @get:Rule(order = 0) val host = object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }
    @get:Rule(order = 1) val compose = createAndroidComposeRule<ComponentActivity>()
    private val fixture = ManagementFixture

    @Before fun start() { fixture.reset() }

    /** [engine]'s page on the fixture's runner. */
    private fun page(engine: String) {
        val session = fixture.session()
        runBlocking { fixture.signIn(session) }
        val api = ManagementApi(session, (session.state.value as AuthState.SignedIn).handle)
        compose.setContent { RunnerScreen(api, fixture.RUNNER, "engine:$engine", 0, {}, {}, {}) }
        compose.waitForIdle()
    }
    private fun await(text: String) = compose.waitUntil(60_000) { compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty() }
    private fun shown(text: String) = compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().size
    private fun press(label: String) = hasText(label) and hasClickAction()
    private val openCodeMissing = """[{"engine":"claude","installed":true,"auth":"yes"},{"engine":"opencode","installed":false,"auth":"unknown"}]"""

    @Test fun openCodeMissingIsInstalledFromItsPage() {
        fixture.runnerEngines = openCodeMissing
        page("opencode")
        await(RunnerCopy.NOT_INSTALLED)
        compose.waitUntil(60_000) { compose.onAllNodes(press("Install OpenCode") and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(press("Install OpenCode")).performScrollTo().performClick()
        compose.waitUntil(60_000) { fixture.installBodies.isNotEmpty() }
        assertEquals(listOf(buildJsonObject { put("engine", "opencode") }), fixture.installBodies.toList())
    }

    @Test fun anInstallThatFailedIsRetriedAndSaysWhatTheRelaySaid() {
        fixture.runnerEngines = openCodeMissing
        fixture.runnerExtra = ""","install":{"engine":"opencode","mode":"install","status":"failed","message":"npm ERR! code EACCES"}"""
        page("opencode")
        await("npm ERR! code EACCES")
        compose.waitUntil(60_000) { compose.onAllNodes(press(Infrastructure.RETRY) and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
        assertEquals(0, shown("Install OpenCode"))
        compose.onNode(press(Infrastructure.RETRY)).performScrollTo().performClick()
        compose.waitUntil(60_000) { fixture.installBodies.isNotEmpty() }
        assertEquals(listOf(buildJsonObject { put("engine", "opencode") }), fixture.installBodies.toList())
    }

    @Test fun anInstallUnderWaySaysInstallingAndOffersNoPress() {
        fixture.runnerEngines = openCodeMissing
        fixture.runnerExtra = ""","install":{"engine":"opencode","mode":"install","status":"installing","message":"Installing opencode-ai…"}"""
        page("opencode")
        await("Installing opencode-ai…")
        await(Infrastructure.INSTALLING)
        assertEquals(0, shown("Install OpenCode"))
        assertEquals(0, shown(Infrastructure.RETRY))
    }

    @Test fun aRunnerThatNeverMentionsOpenCodeOffersNoInstall() {
        fixture.runnerEngines = """[{"engine":"claude","installed":true,"auth":"yes"}]"""
        page("opencode")
        await(RunnerCopy.UPDATE_ENGINES_NOW)
        assertEquals("the web draws such a runner no OpenCode row", 0, shown("Install OpenCode"))
    }

    @Test fun aSignInEngineTheMachineLacksIsInstalledFromItsPage() {
        fixture.runnerEngines = """[{"engine":"claude","installed":true,"auth":"yes"},{"engine":"kimi","installed":false,"auth":"unknown"}]"""
        page("kimi")
        compose.waitUntil(60_000) { compose.onAllNodes(press("Install Kimi Code") and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
        assertEquals("nothing to sign in to yet", 0, shown("Add Account"))
        compose.onNode(press("Install Kimi Code")).performScrollTo().performClick()
        compose.waitUntil(60_000) { fixture.installBodies.isNotEmpty() }
        assertEquals(listOf(buildJsonObject { put("engine", "kimi") }), fixture.installBodies.toList())
    }

    @Test fun anInstalledEngineOffersNoInstall() {
        fixture.runnerEngines = """[{"engine":"claude","installed":true,"auth":"yes","version":"2.1.284"},
            {"engine":"opencode","installed":true,"auth":"unknown","version":"1.18.35"}]"""
        page("claude")
        await("2.1.284")
        assertEquals(0, shown("Install Claude Code"))
        assertFalse(Infrastructure.installsOpenCode(Json.parseToJsonElement("""{"engines":${fixture.runnerEngines}}""").jsonObject))
    }

    /** Antigravity's own install, where the runner can run it at all; none where it says it can't. */
    @Test fun antigravityIsInstalledOnlyWhereTheRunnerCanRunIt() {
        fixture.runnerEngines = """[{"engine":"claude","installed":true,"auth":"yes"}]"""
        page("antigravity")
        compose.waitUntil(60_000) { compose.onAllNodes(press("Install Antigravity CLI") and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
        fixture.runnerExtra = ""","antigravity":{"supported":false,"envKeyAvailable":false}"""
        compose.onNode(press(RunnerCopy.UPDATE_ENGINES_NOW)).performScrollTo().performClick()
        compose.waitUntil(60_000) { compose.onAllNodesWithText("Install Antigravity CLI").fetchSemanticsNodes().isEmpty() }
    }

    @Test fun anOfflineMachineTakesNoInstall() {
        fixture.runnerEngines = openCodeMissing
        fixture.runnerOnline = false
        page("opencode")
        await(RunnerCopy.ENGINES_OFFLINE_FOOTER)
        compose.onNode(press("Install OpenCode")).assertIsNotEnabled()
    }
}
