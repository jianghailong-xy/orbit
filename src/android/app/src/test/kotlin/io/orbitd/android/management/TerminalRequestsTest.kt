package io.orbitd.android.management

import android.content.ComponentName
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.cards.TerminalRequest
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.OrbitLinks
import io.orbitd.android.navigation.OrbitRoute
import io.orbitd.android.navigation.Origin
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
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
 * Terminals asking to be approved, moved off Waiting on you (docs/mocks/waiting-on-you-removal/02-terminal-approvals.html, following
 * iOS): Machines & models' Needs you section holds every machine's cards, a machine's page its own; the needs-you bar's line and the
 * terminal-login push open that section with the card lit. The card and its two doors are main's, unchanged: no confirm first, the card
 * leaves once the door answers, a refusal says the server's words and keeps it; a short notice says it was recorded.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ManagementShellApplication::class)
class TerminalRequestsTest {
    @get:Rule(order = 0) val host = object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }
    @get:Rule(order = 1) val compose = createAndroidComposeRule<ComponentActivity>()
    private val fixture = ManagementFixture
    private val opened = mutableListOf<OrbitRoute>()

    private val first = "01a0d6a9-d763-70e1-b4cf-8793e971b5f1"
    private val second = "01a0d6a9-d763-70e1-b4cf-8793e971b5f2"
    private val elsewhere = "01a0d6a9-d763-70e1-b4cf-8793e971b5f3"
    private fun card(id: String) = "terminal-request:$id"

    /** A terminal on [runner] asking [minutesAgo] minutes ago, its ten minutes running out in [expiresInMs]. */
    private fun request(id: String, runner: String = fixture.RUNNER, machine: String = "dev-laptop", code: String = "7KQ-4MZ",
        minutesAgo: Long = 3, expiresInMs: Long = 7 * 60_000L): JsonObject = buildJsonObject {
        put("id", id); put("userCode", code); put("machineName", machine); put("runnerId", runner)
        put("createdAt", Instant.now().minusSeconds(minutesAgo * 60).toString())
        put("expiresAt", Instant.now().plusMillis(expiresInMs).toString())
    }

    @Before fun start() { fixture.reset() }

    private fun api(): ManagementApi {
        val session = fixture.session()
        runBlocking { fixture.signIn(session) }
        return ManagementApi(session, (session.state.value as AuthState.SignedIn).handle)
    }
    private fun machinesAndModels(record: String? = null) {
        val api = api()
        compose.setContent { RunnerScreen(api, null, record, 0, { opened += it }, {}, {}) }
    }
    private fun awaitTag(tag: String) =
        compose.waitUntil(60_000) { compose.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
    private fun awaitGone(tag: String) =
        compose.waitUntil(60_000) { compose.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().isEmpty() }
    private fun awaitText(text: String) =
        compose.waitUntil(60_000) { compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty() }
    private fun tag(id: String, part: String) = compose.onNodeWithTag("${card(id)}:$part", useUnmergedTree = true)
    private fun posts() = fixture.calls.filter { it.startsWith("POST terminals/") }

    @Test fun machinesAndModelsHoldsTheCardUnchangedAtTheTopOfNeedsYou() {
        fixture.terminalRequests = listOf(request(first))
        machinesAndModels()
        awaitTag(card(first))
        tag(first, "title").assertTextEquals("Approve a terminal?")
        tag(first, "line").assertTextEquals("Terminal on dev-laptop · code 7KQ-4MZ")
        tag(first, "detail").assertTextEquals("It can start sessions in your workspaces on this machine and answer their approval cards for 30 days. " +
            "You can revoke it on this machine's page in Settings.")
        tag(first, "asked").assertTextEquals("Asked 3m ago")
        compose.onNode(hasText("Waiting on you") and hasAnyAncestor(hasTestTag(card(first))), useUnmergedTree = true).assertExists()
        // Under Needs you's own header, above the machines.
        awaitText(MachinesAndModels.MACHINES)
        val header = compose.onNodeWithText(MachinesAndModels.NEEDS_YOU).fetchSemanticsNode().positionInRoot.y
        val cardTop = compose.onNodeWithTag(card(first)).fetchSemanticsNode().positionInRoot.y
        val machines = compose.onNodeWithText(MachinesAndModels.MACHINES).fetchSemanticsNode().positionInRoot.y
        assertTrue("Needs you, then the card, then Machines", header < cardTop && cardTop < machines)
        assertTrue("drawing the card presses nothing", posts().isEmpty())
        compose.onAllNodesWithTag("${card(first)}:lit", useUnmergedTree = true).assertCountEquals(0)
    }

    @Test fun severalWaitOldestFirstAcrossEveryMachine() {
        fixture.terminalRequests = listOf(request(second, minutesAgo = 1, code = "R2T-9PX"),
            request(elsewhere, runner = fixture.RUNNER_TWO, machine = "build-box", minutesAgo = 5, code = "9PL-2XT"), request(first))
        machinesAndModels()
        awaitTag(card(second))
        val tops = listOf(elsewhere, first, second).map { compose.onNodeWithTag(card(it)).fetchSemanticsNode().positionInRoot.y }
        assertEquals("oldest first", tops.sorted(), tops)
    }

    @Test fun approvePostsItsDoorSaysSoAndTheCardLeaves() {
        fixture.terminalRequests = listOf(request(first))
        machinesAndModels()
        awaitTag(card(first))
        tag(first, "approve").performClick()
        awaitGone(card(first))
        assertEquals(listOf("POST terminals/requests/$first/approve"), posts())
        awaitText(TerminalNeedsYou.APPROVED)
    }

    @Test fun denyPostsTheOtherDoorAndSaysSo() {
        fixture.terminalRequests = listOf(request(first))
        machinesAndModels()
        awaitTag(card(first))
        tag(first, "deny").performClick()
        awaitGone(card(first))
        assertEquals(listOf("POST terminals/requests/$first/deny"), posts())
        awaitText(TerminalNeedsYou.DENIED)
    }

    @Test fun aRefusalKeepsTheCardAndSaysTheServersWords() {
        fixture.terminalRequests = listOf(request(first))
        fixture.terminalRefusal = "terminal sign-in not found or expired — run `orbit` in the terminal again"
        machinesAndModels()
        awaitTag(card(first))
        tag(first, "approve").performClick()
        awaitTag("${card(first)}:error")
        tag(first, "error").assertTextContains("That was not recorded", substring = true)
        tag(first, "error").assertTextContains("run `orbit` in the terminal again", substring = true)
        compose.onAllNodesWithText(TerminalNeedsYou.APPROVED).assertCountEquals(0)
    }

    @Test fun aCardFoldsAtItsDeadlineWithoutAnotherRead() {
        fixture.terminalRequests = listOf(request(first, expiresInMs = 1_500))
        machinesAndModels()
        awaitTag(card(first))
        Thread.sleep(1_700)
        compose.mainClock.advanceTimeBy(2_000)
        awaitGone(card(first))
    }

    @Test fun openedOnARequestLightsItsCard() {
        fixture.terminalRequests = listOf(request(first), request(second, minutesAgo = 1))
        machinesAndModels(TerminalNeedsYou.record(second))
        awaitTag("${card(second)}:lit")
        compose.onAllNodesWithTag("${card(first)}:lit", useUnmergedTree = true).assertCountEquals(0)
    }

    @Test fun aMachinesPageDrawsItsOwnCardsOnly() {
        fixture.terminalRequests = listOf(request(first), request(elsewhere, runner = fixture.RUNNER_TWO, machine = "build-box"))
        val api = api()
        compose.setContent { RunnerScreen(api, fixture.RUNNER, null, 0, {}, {}, {}) }
        awaitTag(card(first))
        compose.onAllNodesWithTag(card(elsewhere), useUnmergedTree = true).assertCountEquals(0)
    }

    @Test fun nothingWaitingDrawsNoCard() {
        machinesAndModels()
        compose.waitUntil(60_000) { fixture.calls.contains("GET terminals/requests") }
        awaitText(MachinesAndModels.MACHINES)
        compose.onAllNodesWithTag("terminal-requests", useUnmergedTree = true).assertCountEquals(0)
    }

    /** The notice (board ③ as a toast, the owner 2026-11-16): one request names its machine and code; pressed, it lands on that
     * machine's page with its card lit. The title and detail words for several stay the Settings and section words. */
    @Test fun theNoticeSaysWhatWaitsAndWhereAndOpensItsMachine() {
        fun r(id: String, machine: String, code: String) = TerminalRequest(id, userCode = code, machineName = machine, runnerId = fixture.RUNNER,
            createdAt = "2026-11-14T10:00:00Z", expiresAt = "2026-11-14T10:10:00Z")
        val one = TerminalNeedsYou.toast(r(first, "dev-laptop", "7KQ-4MZ"))
        assertEquals("Approve a terminal", one.title)
        assertEquals("dev-laptop · code 7KQ-4MZ", one.line)
        assertEquals("terminal:$first", one.id)
        assertEquals(first, one.terminalRequest)
        assertEquals(io.orbitd.android.cards.NeedsYouGlyph.TERMINAL, one.glyph)
        assertEquals("Approve 2 terminals", TerminalNeedsYou.title(2))
        assertEquals("dev-laptop · 2 waiting", TerminalNeedsYou.detail(listOf(r(first, "dev-laptop", "7KQ-4MZ"), r(second, "dev-laptop", "R2T-9PX"))))
        assertEquals(OrbitRoute(Destination.RUNNER, fixture.RUNNER, recordId = "terminal:$first", origin = Origin.LIST),
            TerminalNeedsYou.machineRoute(r(first, "dev-laptop", "7KQ-4MZ")))
        assertEquals(OrbitRoute(Destination.RUNNER, recordId = "terminal:$first", origin = Origin.LIST), TerminalNeedsYou.route(first))
    }

    /** Where the notice lands: that machine's page, its Terminals to approve, the request's card lit. */
    @Test fun theNoticeLandsOnItsMachinesTerminalsToApprove() {
        fixture.terminalRequests = listOf(request(first))
        val api = api()
        val route = TerminalNeedsYou.machineRoute(TerminalRequest(first, userCode = "7KQ-4MZ", machineName = "dev-laptop",
            runnerId = fixture.RUNNER, createdAt = "2026-11-14T10:00:00Z", expiresAt = "2026-11-14T10:10:00Z"))
        compose.setContent { RunnerScreen(api, route.id, route.recordId, 0, {}, {}, {}) }
        awaitTag("${card(first)}:lit")
        awaitText(TerminalNeedsYou.TO_APPROVE)
    }

    /** The push's link lands on Machines & models' Needs you, the request's card lit. */
    @Test fun theTerminalLoginLinkLandsWhereTheLineDoes() {
        assertEquals(TerminalNeedsYou.route(first, Origin.EXTERNAL), OrbitLinks.parse("orbit://terminal-login/$first", origin = Origin.EXTERNAL))
        assertNull(OrbitLinks.parse("orbit://terminal-login/"))
    }

    @Test fun anExpiredRequestIsNotLive() {
        fun r(id: String, expires: Long, created: Long) = TerminalRequest(id, userCode = "X", machineName = "m", runnerId = fixture.RUNNER,
            createdAt = Instant.ofEpochMilli(created).toString(), expiresAt = Instant.ofEpochMilli(expires).toString())
        val now = 1_000_000L
        assertEquals(listOf(second, first), TerminalRequestStore.live(listOf(r(first, now + 1, 20), r(second, now + 5, 10), r(elsewhere, now, 0)), now)
            .map { it.id })
    }
}
