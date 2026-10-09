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
 * A07-5 (iOS e789ce3dc, RunnerEnginePage's `dshSection`): DeepSeek Harness's page on a runner over the controlled server. Harness
 * signs nothing in there; the page says why the machine can't run it, offers Install DeepSeek Harness where an install fixes that,
 * and says what the install relay says while it runs.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ManagementShellApplication::class)
class DshEnginePageTest {
    @get:Rule(order = 0) val host = object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }
    @get:Rule(order = 1) val compose = createAndroidComposeRule<ComponentActivity>()
    private val fixture = ManagementFixture

    @Before fun start() { fixture.reset() }

    /** Harness's page on the fixture's runner. */
    private fun page() {
        val session = fixture.session()
        runBlocking { fixture.signIn(session) }
        val api = ManagementApi(session, (session.state.value as AuthState.SignedIn).handle)
        compose.setContent { RunnerScreen(api, fixture.RUNNER, "engine:dsh", 0, {}, {}, {}) }
        compose.waitForIdle()
    }
    private fun await(text: String) = compose.waitUntil(60_000) { compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty() }
    private fun shown(text: String) = compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().size
    private fun harness(installed: Boolean, compatible: Boolean = true, error: String? = null) =
        """[{"engine":"dsh","installed":$installed,${if (installed) """"version":"0.2.0-rc.2",""" else ""}"auth":"unknown",""" +
            (error?.let { """"installationError":"$it",""" } ?: "") + """"dsh":{"versionCompatible":$compatible}}]"""
    private val install = hasText("Install DeepSeek Harness") and hasClickAction()

    @Test fun aRunnerWithoutHarnessInstallsItFromItsPage() {
        fixture.runnerEngines = harness(installed = false)
        fixture.runnerExtra = ""","capabilities":["provider:dsh"]"""
        page()
        await("Install DeepSeek Harness on this runner from Infrastructure.")
        compose.waitUntil(60_000) { compose.onAllNodes(install and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(install).performScrollTo().performClick()
        compose.waitUntil(60_000) { fixture.installBodies.isNotEmpty() }
        assertEquals(listOf(buildJsonObject { put("engine", "dsh") }), fixture.installBodies.toList())
    }

    @Test fun aVersionOrbitDoesntSupportIsReinstalled() {
        fixture.runnerEngines = harness(installed = true, compatible = false)
        fixture.runnerExtra = ""","capabilities":["provider:dsh"]"""
        page()
        await("This runner has a DeepSeek Harness version Orbit does not support. Reinstall it from Infrastructure.")
        compose.waitUntil(60_000) { compose.onAllNodes(install and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
    }

    @Test fun whatAnInstallCantFixIsSaidWithNoInstall() {
        // A runner that predates Harness updates itself.
        fixture.runnerEngines = harness(installed = false)
        page()
        await("This runner predates DeepSeek Harness. It updates itself when no session is running on it.")
        assertEquals(0, shown("Install DeepSeek Harness"))
    }

    @Test fun aPlatformHarnessDoesntRunOnIsSaidWithNoInstall() {
        fixture.runnerEngines = harness(installed = false, error = "DSH_PLATFORM_UNSUPPORTED: darwin/arm64")
        fixture.runnerExtra = ""","capabilities":["provider:dsh"]"""
        page()
        await("DeepSeek Harness 0.2.0-rc.2 runs on Linux x64 runners with Node 26 only.")
        assertEquals(0, shown("Install DeepSeek Harness"))
    }

    @Test fun anInstallUnderWaySaysWhatTheRelaySaysAndTakesNoSecondPress() {
        fixture.runnerEngines = harness(installed = false)
        fixture.runnerExtra = ""","capabilities":["provider:dsh"],"install":{"engine":"dsh","mode":"install","status":"installing",""" +
            """"message":"Installing DeepSeek Harness 0.2.0-rc.2…"}"""
        page()
        await("Installing DeepSeek Harness 0.2.0-rc.2…")
        compose.onNode(install).assertIsNotEnabled()
    }

    @Test fun aReadyRunnerHasNothingToFixHere() {
        fixture.runnerEngines = harness(installed = true)
        fixture.runnerExtra = ""","capabilities":["provider:dsh"]"""
        page()
        await("0.2.0-rc.2")
        assertEquals(0, shown("Install DeepSeek Harness"))
        assertEquals(0, shown("Infrastructure"))
    }
}
