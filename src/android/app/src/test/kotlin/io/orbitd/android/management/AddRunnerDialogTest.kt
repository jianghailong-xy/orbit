package io.orbitd.android.management

import android.content.ComponentName
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.*
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.core.auth.AuthState
import kotlinx.coroutines.CompletableDeferred
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
import java.time.Instant

/**
 * Add Runner's machine with no browser (iOS AddRunnerSheet), against the fixture's runners/device routes: a request still PENDING offers
 * Deny beside Approve, both wait while either press is in flight, and Deny posts runners/device/:code/deny and then says nothing was
 * added, in the web /enroll page's words; one already DENIED opens as denied, with no Approve; a decision the server refuses says the
 * server's sentence where failures show and leaves the request to decide; approving and a runner already of the name say the page's words.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ManagementShellApplication::class)
class AddRunnerDialogTest {
    @get:Rule(order = 0) val host = object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }
    @get:Rule(order = 1) val compose = createAndroidComposeRule<ComponentActivity>()
    private val fixture = ManagementFixture

    @Before fun start() { fixture.reset() }

    /** The dialog, with the code `orbit register` printed typed in, once the machine it names shows. */
    private fun lookUp() {
        val session = fixture.session()
        runBlocking { fixture.signIn(session) }
        val api = ManagementApi(session, (session.state.value as AuthState.SignedIn).handle)
        compose.setContent { AddRunnerDialog(api, {}, {}) }
        compose.onNode(hasSetTextAction()).performTextInput(fixture.DEVICE_CODE)
        await("vmi3337007")
    }
    private fun await(text: String) = compose.waitUntil(60_000) { compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty() }
    private fun press(label: String) = hasText(label) and hasClickAction()
    private fun presses(label: String) = compose.onAllNodes(press(label)).fetchSemanticsNodes().size
    /** Pressed through its semantics once it can be: a dialog's buttons take no injected touch while it settles. */
    private fun tap(label: String) {
        compose.waitUntil(60_000) { compose.onAllNodes(press(label) and isEnabled()).fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(press(label)).performSemanticsAction(SemanticsActions.OnClick)
        compose.waitForIdle()
    }
    private fun decisions() = fixture.calls.filter { it.startsWith("POST runners/device/") }

    @Test fun aPendingRequestOffersDenyBesideApproveAndDenyingSaysNothingWasAdded() {
        lookUp()
        compose.onNode(press(RunnerCopy.APPROVE)).assertIsEnabled()
        compose.onNode(press(RunnerCopy.DENY)).assertIsEnabled()
        val gate = CompletableDeferred<Unit>().also { fixture.deviceGate = it }
        tap(RunnerCopy.DENY)
        // Both wait while the press is in flight.
        compose.waitUntil(10_000) { compose.onAllNodes(press(RunnerCopy.DENY) and isNotEnabled()).fetchSemanticsNodes().isNotEmpty() }
        compose.onNode(press(RunnerCopy.APPROVE)).assertIsNotEnabled()
        gate.complete(Unit)
        await(RunnerCopy.DEVICE_DENIED)
        await(RunnerCopy.DEVICE_DENIED_DETAIL)
        assertEquals(listOf("POST runners/device/${fixture.DEVICE_CODE}/deny"), decisions())
        assertEquals("no Approve once it is denied", 0, presses(RunnerCopy.APPROVE))
        assertEquals(0, presses(RunnerCopy.DENY))
    }

    @Test fun aRequestAlreadyDecidedOpensOnItsDecisionWithNoApprove() {
        fixture.deviceStatus = "DENIED"
        lookUp()
        await(RunnerCopy.DEVICE_DENIED)
        await(RunnerCopy.DEVICE_DENIED_DETAIL)
        assertEquals("a denied request offers no Approve", 0, presses(RunnerCopy.APPROVE))
        assertEquals(0, presses(RunnerCopy.DENY))
        assertEquals(0, presses(RunnerCopy.REREGISTER))
        assertTrue("opening it decides nothing", decisions().isEmpty())
    }

    @Test fun anApprovedRequestOpensRegistered() {
        fixture.deviceStatus = "APPROVED"
        lookUp()
        await(RunnerCopy.DEVICE_APPROVED)
        await(RunnerCopy.deviceApprovedDetail("devbox"))
        assertEquals(0, presses(RunnerCopy.APPROVE))
        assertEquals(0, presses(RunnerCopy.DENY))
        assertTrue(decisions().isEmpty())
    }

    @Test fun aDecisionTheServerRefusesSaysItsSentenceAndTheRequestStaysToDecide() {
        lookUp()
        // Denied from a browser after this lookup read it PENDING.
        fixture.deviceStatus = "DENIED"
        tap(RunnerCopy.APPROVE)
        await("This registration request was denied — run `orbit register` again")
        compose.onNode(press(RunnerCopy.APPROVE)).assertIsEnabled()
        compose.onNode(press(RunnerCopy.DENY)).assertIsEnabled()
        // And the other way round: approved meanwhile, then denied here.
        fixture.deviceStatus = "APPROVED"
        tap(RunnerCopy.DENY)
        await("This registration request was already approved")
        assertEquals(0, compose.onAllNodesWithText("This registration request was denied", substring = true).fetchSemanticsNodes().size)
        assertEquals(listOf("POST runners/device/${fixture.DEVICE_CODE}/approve", "POST runners/device/${fixture.DEVICE_CODE}/deny"), decisions())
        assertEquals(0, compose.onAllNodesWithText(RunnerCopy.DEVICE_DENIED, substring = true).fetchSemanticsNodes().size)
    }

    @Test fun aRunnerOfTheSameNameAndApprovingSayThePagesWords() {
        fixture.deviceConflict = true
        fixture.deviceLastSeen = Instant.now().minusSeconds(3 * 86_400 + 600).toString()
        lookUp()
        await(RunnerCopy.deviceNameTaken("devbox"))
        await("Last online 3d ago. ${RunnerCopy.DEVICE_NAME_TAKEN_DETAIL}")
        assertEquals("the old button's words are gone", 0, presses("Re-register machine"))
        compose.onNode(press(RunnerCopy.DENY)).assertIsEnabled()
        tap(RunnerCopy.REREGISTER)
        await(RunnerCopy.DEVICE_APPROVED)
        await(RunnerCopy.deviceApprovedDetail("devbox"))
        assertEquals(listOf("POST runners/device/${fixture.DEVICE_CODE}/approve"), decisions())
        assertEquals(0, presses(RunnerCopy.REREGISTER))
        assertEquals(0, presses(RunnerCopy.DENY))
    }
}
