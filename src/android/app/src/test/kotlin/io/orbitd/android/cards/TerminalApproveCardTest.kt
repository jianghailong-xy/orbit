package io.orbitd.android.cards

import android.content.ComponentName
import androidx.activity.ComponentActivity
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.ui.OrbitTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import org.junit.After
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
 * A terminal asking to be approved, in the Waiting on you inbox (iOS `TerminalApproveCard`, web `TerminalApproveCard.tsx`): its card
 * heads the Open tab in iOS's words, counts with the requests in the header and the drawer, and Approve and Deny press their doors on
 * the real wire — the card leaving and the list read again. A server that predates terminals draws no card and no error.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h891dp")
class TerminalApproveCardTest {
    @get:Rule(order = 0) val host = object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }
    @get:Rule(order = 1) val compose = createComposeRule()

    private val fixture = OwnerRequestFixture()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private lateinit var store: OwnerRequestStore
    private val id = OwnerRequestFixture.TERMINAL_REQUEST
    private val card = "terminal-request:$id"

    @Before fun setUp() {
        OwnerRequestSnoozes.reset(RuntimeEnvironment.getApplication())
        fixture.hold(OwnerRequestFixture.confirm())
        fixture.terminalRequests += OwnerRequestFixture.terminalRequest()
        store = OwnerRequestStore(fixture.auth, runBlocking { fixture.signIn() }, scope)
    }
    @After fun tearDown() { scope.cancel(); runBlocking { fixture.auth.logout() }; fixture.close() }

    private fun inbox() = compose.setContent { OrbitTheme(darkTheme = false) { WaitingOnYouScreen(store, emptyList(), null, 0, {}) } }
    private fun tag(part: String) = compose.onNodeWithTag("$card:$part", useUnmergedTree = true)
    private fun awaitTag(tag: String) = compose.waitUntil(60_000) { compose.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
    private fun awaitGone(tag: String) = compose.waitUntil(60_000) { compose.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().isEmpty() }
    private fun posts() = fixture.calls.filter { it.method == "POST" && it.path.startsWith("/api/terminals/") }.map { it.path }

    @Test fun theCardHeadsTheOpenTabInIosWordsAndCountsWithTheRequests() {
        inbox()
        awaitTag(card)
        tag("title").assertTextEquals("Approve a terminal?")
        tag("line").assertTextEquals("Terminal on dev-laptop · code 7KQ-4MZ")
        tag("detail").assertTextEquals("It can start sessions in your workspaces on this machine and answer their approval cards for 30 days. " +
            "You can revoke it in Settings → Terminals.")
        tag("asked").assertTextEquals("Asked 3m ago")
        compose.onNodeWithTag("$card:deny").assertTextContains("Deny")
        compose.onNodeWithTag("$card:approve").assertTextContains("Approve")
        compose.onNode(hasText("Waiting on you") and hasAnyAncestor(hasTestTag(card)), useUnmergedTree = true).assertExists()
        // One confirmation and one terminal: one count.
        compose.waitUntil(60_000) { store.state.value.open.size == 1 }
        compose.onNodeWithTag("waiting-on-you:count", useUnmergedTree = true).assertTextEquals("2")
        // Whole, at the top: above the request's row.
        val row = "waiting-on-you:row:${OwnerRequestFixture.CONFIRM_ID}"
        assertTrue(compose.onNodeWithTag(card).fetchSemanticsNode().boundsInRoot.bottom <= compose.onNodeWithTag(row).fetchSemanticsNode().boundsInRoot.top)
        assertTrue("drawing the card presses nothing", posts().isEmpty())
    }

    @Test fun approvePostsItsDoorAndTheCardLeaves() {
        inbox()
        awaitTag(card)
        val reads = fixture.calls.count { it.path == "/api/terminals/requests" }
        tag("approve").performClick()
        awaitGone(card)
        assertEquals(listOf("/api/terminals/requests/$id/approve"), posts())
        assertEquals("", fixture.calls.first { it.path.endsWith("/approve") }.body)
        compose.waitUntil(60_000) { fixture.calls.count { it.path == "/api/terminals/requests" } > reads }
        compose.waitUntil(60_000) { runCatching { compose.onNodeWithTag("waiting-on-you:count", useUnmergedTree = true).assertTextEquals("1") }.isSuccess }
    }

    @Test fun denyPostsItsDoorAndTheCardLeaves() {
        inbox()
        awaitTag(card)
        tag("deny").performClick()
        awaitGone(card)
        assertEquals(listOf("/api/terminals/requests/$id/deny"), posts())
    }

    @Test fun aRequestAlreadyGoneSaysWhyAndTheListIsReadAgain() {
        store.loadTerminalRequests()
        compose.waitUntil(60_000) { store.state.value.terminalRequests.size == 1 }
        val request = store.state.value.terminalRequests.single()
        // Decided on another device, or its ten minutes ran out, before this press.
        fixture.terminalRequests.clear()
        assertEquals("terminal sign-in not found", runBlocking { store.decideTerminal(request, approve = true) })
        // The read after the press finds it gone, and the card goes with it.
        compose.waitUntil(60_000) { store.state.value.terminalRequests.isEmpty() }
    }

    @Test fun anOnlyTerminalRequestIsNotNothingWaiting() {
        fixture.held.clear()
        inbox()
        awaitTag(card)
        compose.waitUntil(60_000) { OwnerRequestStore.OPEN in store.state.value.lists }
        compose.waitForIdle()
        compose.onAllNodesWithTag("waiting-on-you:empty", useUnmergedTree = true).assertCountEquals(0)
        compose.onNodeWithTag("waiting-on-you:count", useUnmergedTree = true).assertTextEquals("1")
        tag("deny").performClick()
        awaitTag("waiting-on-you:empty")
        compose.onNodeWithText("Nothing is waiting on you.").assertExists()
    }

    @Test fun aServerWithoutTerminalsDrawsNoCardAndNoError() {
        fixture.terminalsMissing = true
        inbox()
        awaitTag("waiting-on-you:row:${OwnerRequestFixture.CONFIRM_ID}")
        compose.waitUntil(60_000) { fixture.calls.any { it.path == "/api/terminals/requests" } }
        compose.waitForIdle()
        compose.onAllNodesWithTag(card, useUnmergedTree = true).assertCountEquals(0)
        compose.onAllNodesWithText("Couldn't read", substring = true).assertCountEquals(0)
        compose.onNodeWithTag("waiting-on-you:count", useUnmergedTree = true).assertTextEquals("1")
    }

    /** The drawer's count beside Waiting on you counts the terminals too, and `terminals.changed` reads them again. */
    @Test fun theDrawerCountsTerminalsAndReadsThemAgainOnTheirEvent() {
        var changed by mutableLongStateOf(0L)
        compose.setContent { OrbitTheme(darkTheme = false) { WaitingOnYouDrawerCount(store, emptyList(), 0, changed) } }
        compose.waitUntil(60_000) { runCatching {
            compose.onNodeWithTag("waiting-on-you-drawer-count", useUnmergedTree = true).assertTextEquals("2") }.isSuccess }
        fixture.terminalRequests += OwnerRequestFixture.terminalRequest("01a0d6a9-d763-70e1-b4cf-8793e971b5f2", "build-box", "9PL-2XT")
        changed = 1
        compose.waitUntil(60_000) { runCatching {
            compose.onNodeWithTag("waiting-on-you-drawer-count", useUnmergedTree = true).assertTextEquals("3") }.isSuccess }
        compose.onNodeWithContentDescription("3 waiting on you").assertExists()
    }
}
