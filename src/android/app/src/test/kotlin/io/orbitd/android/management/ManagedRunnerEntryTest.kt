package io.orbitd.android.management

import android.content.ComponentName
import androidx.activity.ComponentActivity
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.composer.ManagedRunner
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
 * Setting up a managed runner from an existing account on Android (docs/managed-runner-existing-account-entry-design.md, D1–D5 = A):
 * Machines & models' Managed runner section when the server offers one, the question before Set up, the runner's page after it, and the
 * managed runner as one machine with the shared state's short label and its banner. With the feature off there is no section and no
 * GET managed-runner.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ManagementShellApplication::class)
class ManagedRunnerEntryTest {
    @get:Rule(order = 0) val host = object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }
    @get:Rule(order = 1) val compose = createAndroidComposeRule<ComponentActivity>()
    private val fixture = ManagementFixture
    private val opened = mutableListOf<OrbitRoute>()

    @Before fun start() { fixture.reset() }

    private fun api(): ManagementApi {
        val session = fixture.session()
        runBlocking { fixture.signIn(session) }
        return ManagementApi(session, (session.state.value as AuthState.SignedIn).handle)
    }
    private fun page() {
        val api = api()
        compose.setContent { MachinesAndModelsSettings(api, 0, null, { opened += it }, {}) }
    }
    /** One page at a time, each on its own sign-in: a case of a loop gets a page of its own, as setContent is called once a test. */
    private var current by mutableStateOf<ManagementApi?>(null)
    private var hosting = false
    private fun show(api: ManagementApi) {
        if (!hosting) { hosting = true; compose.setContent { current?.let { key(it) { MachinesAndModelsSettings(it, 0, null, { r -> opened += r }, {}) } } } }
        compose.runOnIdle { current = api }
    }
    private fun hide() { compose.runOnIdle { current = null }; compose.waitForIdle() }
    private fun runnerPage(id: String) {
        val api = api()
        compose.setContent { RunnerScreen(api, id, null, 0, { opened += it }, {}, {}) }
    }
    private fun await(text: String) = compose.waitUntil(60_000) { compose.onAllNodesWithText(text, substring = true, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
    private fun top(text: String) = compose.onAllNodesWithText(text, useUnmergedTree = true)[0].fetchSemanticsNode().positionInRoot.y
    private fun none(text: String) = compose.onAllNodesWithText(text, substring = true, useUnmergedTree = true).assertCountEquals(0)
    private fun managedReads() = fixture.calls.count { it == "GET managed-runner" }
    /** The page has read the machines and the keys: whatever it was going to ask, it has asked. */
    private fun settled() { await(RunnerCopy.ADD); await(MachinesAndModels.NO_KEYS); compose.waitForIdle() }

    @Test fun featureOffAServerWithoutTheCapabilityShowsNoSectionAndNeverReadsTheStatus() {
        fixture.capabilities = null // a server from before the feature: 404
        fixture.managedStatus = fixture.managed("NOT_PROVISIONED", canEnsure = true)
        page()
        settled()
        none(ManagedRunner.Entry.TITLE)
        none(ManagedRunner.Entry.SUBTITLE)
        assertTrue(fixture.calls.toString(), "GET auth/capabilities" in fixture.calls)
        assertEquals(fixture.calls.toString(), 0, managedReads())
    }

    @Test fun featureOffTheCapabilitySwitchedOffShowsNoSectionAndNeverReadsTheStatus() {
        for (capability in listOf("""{"managedRunners":{"enabled":false,"contractVersion":1}}""",
            """{"managedRunners":{"enabled":true,"contractVersion":2}}""", "{}")) {
            fixture.reset()
            fixture.capabilities = capability
            fixture.managedStatus = fixture.managed("NOT_PROVISIONED", canEnsure = true)
            fixture.runnerOnline = false
            show(api())
            settled()
            none(ManagedRunner.Entry.TITLE)
            // The machine reads by its heartbeat, as today.
            compose.onAllNodesWithText(RunnerCopy.OFFLINE, useUnmergedTree = true).assertCountEquals(1)
            assertEquals("$capability: ${fixture.calls}", 0, managedReads())
            hide()
        }
    }

    @Test fun aStatusWithNoManagedUiShowsNoSection() {
        for (status in listOf(fixture.managed("NOT_PROVISIONED", canEnsure = false), // not offered (D2)
            fixture.managed("NOT_PROVISIONED", canEnsure = true, enabled = false),
            fixture.managed("SLEEPING", fixture.RUNNER, enabled = false, reason = "MANAGED_RUNNER_DISABLED"), "{}")) {
            fixture.reset()
            fixture.capabilities = ManagementFixture.MANAGED_ON
            fixture.managedStatus = status
            fixture.runnerOnline = false
            show(api())
            settled()
            compose.waitUntil(10_000) { managedReads() > 0 }
            compose.waitForIdle()
            none(ManagedRunner.Entry.TITLE)
            // A leftover managed runner shows by its heartbeat, as today.
            compose.onAllNodesWithText(RunnerCopy.OFFLINE, useUnmergedTree = true).assertCountEquals(1)
            compose.onAllNodesWithTag("managed-runner-label", useUnmergedTree = true).assertCountEquals(0)
            hide()
        }
    }

    @Test fun offeredTheSectionStandsAfterNeedsYouAndBeforeMachines() {
        fixture.capabilities = ManagementFixture.MANAGED_ON
        fixture.managedStatus = fixture.managed("NOT_PROVISIONED", canEnsure = true)
        fixture.secondRunner = true; fixture.runnerTwoOnline = false // so Needs you has a line
        page()
        await(ManagedRunner.Entry.SUBTITLE)
        await(MachinesAndModels.NEEDS_YOU)
        compose.onNode(hasText("Set up a managed runner") and hasAnyAncestor(hasTestTag("managed-runner-entry")), useUnmergedTree = true).assertExists()
        val order = listOf(MachinesAndModels.NEEDS_YOU, ManagedRunner.Entry.TITLE, MachinesAndModels.MACHINES, RunnerCopy.ADD)
        val tops = order.map(::top)
        assertEquals("top to bottom: $order", tops.sorted(), tops)
    }

    @Test fun setUpAsksFirstAndCancelSetsNothingUp() {
        fixture.capabilities = ManagementFixture.MANAGED_ON
        fixture.managedStatus = fixture.managed("NOT_PROVISIONED", canEnsure = true)
        page()
        await(ManagedRunner.Entry.SUBTITLE)
        compose.onNode(hasText(ManagedRunner.Entry.ACTION) and hasClickAction()).performClick()
        await(ManagedRunner.Confirm.TITLE)
        compose.onNodeWithText(ManagedRunner.Confirm.BODY).assertExists()
        compose.onNodeWithText(ManagedRunner.Confirm.CANCEL).performClick()
        compose.waitForIdle()
        none(ManagedRunner.Confirm.TITLE)
        assertTrue(fixture.ensureBodies.isEmpty())
        assertTrue(opened.isEmpty())
    }

    @Test fun setUpConfirmedEnsuresOnceAndOpensTheRunnersPage() {
        fixture.capabilities = ManagementFixture.MANAGED_ON
        fixture.managedStatus = fixture.managed("NOT_PROVISIONED", canEnsure = true)
        val requested = fixture.managed("REQUESTED", fixture.RUNNER_TWO)
        fixture.ensured = requested
        fixture.onEnsure = { fixture.secondRunner = true; fixture.runnerTwoOnline = false; fixture.managedStatus = requested }
        page()
        await(ManagedRunner.Entry.SUBTITLE)
        compose.onNode(hasText(ManagedRunner.Entry.ACTION) and hasClickAction()).performClick()
        await(ManagedRunner.Confirm.BODY)
        compose.onNode(hasText(ManagedRunner.Confirm.CONFIRM) and hasClickAction() and hasAnyAncestor(isDialog())).performClick()
        compose.waitUntil(10_000) { opened.isNotEmpty() }
        assertEquals(listOf(OrbitRoute(Destination.RUNNER, fixture.RUNNER_TWO)), opened)
        assertEquals(1, fixture.ensureBodies.size)
        assertFalse(fixture.ensureBodies[0]["idempotencyKey"].toString().isBlank())
        // From here on the entry is gone: the managed runner is one machine, its row the shared state's label.
        await("Preparing")
        none(ManagedRunner.Entry.SUBTITLE)
        compose.onNode(hasText("Preparing") and hasTestTag("managed-runner-label"), useUnmergedTree = true).assertExists()
        none("Spare box is offline")
    }

    @Test fun aRefusedSetUpSaysTheServersSentenceAndOpensNothing() {
        fixture.capabilities = ManagementFixture.MANAGED_ON
        fixture.managedStatus = fixture.managed("NOT_PROVISIONED", canEnsure = true)
        fixture.ensureRefusal = "This Orbit account is disabled."
        page()
        await(ManagedRunner.Entry.SUBTITLE)
        compose.onNode(hasText(ManagedRunner.Entry.ACTION) and hasClickAction()).performClick()
        await(ManagedRunner.Confirm.BODY)
        compose.onNode(hasText(ManagedRunner.Confirm.CONFIRM) and hasClickAction() and hasAnyAncestor(isDialog())).performClick()
        await("This Orbit account is disabled.")
        assertTrue(opened.isEmpty())
    }

    @Test fun anAsleepManagedRunnersRowSaysAsleepNeverOffline() {
        fixture.capabilities = ManagementFixture.MANAGED_ON
        fixture.managedStatus = fixture.managed("SLEEPING", fixture.RUNNER, initialProvider = "claude")
        fixture.runnerOnline = false
        page()
        await(ManagedRunner.SHORT.getValue("sleeping"))
        compose.onNode(hasText("Asleep") and hasTestTag("managed-runner-label"), useUnmergedTree = true).assertExists()
        compose.onNodeWithText(ManagedRunner.Asleep.ROW, useUnmergedTree = true).assertExists()
        none(RunnerCopy.OFFLINE)
        none("is offline")
        none(ManagedRunner.Entry.TITLE)
    }

    @Test fun everyMappedStateIsTheRowsShortLabel() {
        val cases = listOf(
            fixture.managed("READY", fixture.RUNNER, usable = true, initialProvider = "claude") to "Ready",
            fixture.managed("STARTING", fixture.RUNNER, initialProvider = "claude") to "Waking up…",
            fixture.managed("SLEEPING", fixture.RUNNER, desired = "RUNNING", initialProvider = "claude") to "Waking up…",
            fixture.managed("DRAINING", fixture.RUNNER, initialProvider = "claude") to "Going to sleep",
            fixture.managed("FAILED", fixture.RUNNER) to "Failed",
        )
        for ((status, label) in cases) {
            fixture.reset()
            fixture.capabilities = ManagementFixture.MANAGED_ON
            fixture.managedStatus = status
            fixture.runnerOnline = label == "Ready"
            show(api())
            await(RunnerCopy.ADD)
            compose.waitUntil(10_000) { compose.onAllNodes(hasText(label) and hasTestTag("managed-runner-label"), useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
            none(RunnerCopy.OFFLINE)
            hide()
        }
    }

    @Test fun theManagedRunnersPageCarriesItsBannerAndLabel() {
        fixture.capabilities = ManagementFixture.MANAGED_ON
        fixture.managedStatus = fixture.managed("SLEEPING", fixture.RUNNER, initialProvider = "claude")
        fixture.runnerOnline = false
        runnerPage(fixture.RUNNER)
        await("Managed runner asleep")
        compose.onNode(hasText("Managed runner asleep") and hasAnyAncestor(hasTestTag("managed-runner-notice")), useUnmergedTree = true).assertExists()
        compose.onNodeWithText("Asleep · ${ManagedRunner.Asleep.ROW}", useUnmergedTree = true).assertExists()
        // Its Resources section says Asleep too, not the Offline another machine says there.
        compose.onAllNodesWithText(RunnerCopy.RESOURCES_OFFLINE, useUnmergedTree = true).assertCountEquals(0)
        compose.onAllNodesWithText(RunnerCopy.RESOURCES, useUnmergedTree = true).assertCountEquals(1)
        none("is offline")
    }

    @Test fun anotherRunnersPageHasNoBanner() {
        fixture.capabilities = ManagementFixture.MANAGED_ON
        fixture.secondRunner = true
        fixture.managedStatus = fixture.managed("SLEEPING", fixture.RUNNER_TWO, initialProvider = "claude")
        runnerPage(fixture.RUNNER)
        await(fixture.runnerAlias)
        compose.waitUntil(10_000) { managedReads() > 0 }
        compose.waitForIdle()
        compose.onAllNodesWithTag("managed-runner-notice", useUnmergedTree = true).assertCountEquals(0)
    }

    @Test fun featureOffTheRunnersPageNeverReadsTheStatus() {
        fixture.capabilities = null
        runnerPage(fixture.RUNNER)
        await(fixture.runnerAlias)
        compose.waitForIdle()
        compose.onAllNodesWithTag("managed-runner-notice", useUnmergedTree = true).assertCountEquals(0)
        assertEquals(fixture.calls.toString(), 0, managedReads())
    }
}
