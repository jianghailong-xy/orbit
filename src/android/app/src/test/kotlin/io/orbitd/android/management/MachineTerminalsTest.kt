package io.orbitd.android.management

import android.content.ComponentName
import androidx.activity.ComponentActivity
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.OrbitRoute
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
import java.time.Instant
import java.time.temporal.ChronoUnit

/** A machine page's Terminals over the controlled server (docs/mocks/terminals-on-machine-page/01-board.html; web
 * `MachineTerminalsSection`): this machine's approved terminals only, newest first, each "Approved <date>" over "last used · expires",
 * between Workspaces and About; nothing while it has none; Revoke only after asking — with Cancel beside it — and the list read again
 * after it so the revoked terminal is gone; an approve card decided on the page brings its terminal in. Settings has no Terminals row,
 * and the old route opens Machines & models. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ManagementShellApplication::class)
class MachineTerminalsTest {
    @get:Rule(order = 0) val host = object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }
    @get:Rule(order = 1) val compose = createComposeRule()
    private val fixture = ManagementFixture
    private val now = Instant.now()

    private fun terminal(id: String, approvedDaysAgo: Long, lastUsedAt: Instant?, runner: String = ManagementFixture.RUNNER) = buildJsonObject {
        put("id", id); put("machineName", "dev-laptop"); put("runnerId", runner)
        put("createdAt", now.minus(approvedDaysAgo, ChronoUnit.DAYS).toString())
        put("approvedAt", now.minus(approvedDaysAgo, ChronoUnit.DAYS).toString())
        put("lastUsedAt", lastUsedAt?.toString()?.let(::JsonPrimitive) ?: JsonNull)
        put("expiresAt", now.plus(30 - approvedDaysAgo, ChronoUnit.DAYS).toString())
    }

    @Before fun start() {
        fixture.reset()
        fixture.terminals = listOf(terminal("term1", 4, now.minusSeconds(180)), terminal("elsewhere", 1, null, ManagementFixture.RUNNER_TWO),
            terminal("term2", 2, null))
    }

    private fun api(): ManagementApi {
        val session = fixture.session()
        runBlocking { fixture.signIn(session) }
        return ManagementApi(session, (session.state.value as AuthState.SignedIn).handle)
    }
    private fun machinePage() {
        val api = api()
        compose.setContent { RunnerScreen(api, ManagementFixture.RUNNER, null, 0, {}, {}, {}) }
    }
    private fun await(text: String) = compose.waitUntil(60_000) { compose.onAllNodesWithText(text, substring = true, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
    private fun awaitTag(tag: String) = compose.waitUntil(60_000) { compose.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
    private fun awaitTagGone(tag: String) = compose.waitUntil(60_000) { compose.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().isEmpty() }
    private fun reads() = fixture.calls.count { it == "GET terminals" }
    private fun top(tag: String) = compose.onNodeWithTag(tag, useUnmergedTree = true).fetchSemanticsNode().positionInRoot.y
    private fun topOf(text: String) = compose.onNodeWithText(text, useUnmergedTree = true).fetchSemanticsNode().positionInRoot.y

    @Test fun listsThisMachinesTerminalsNewestFirstBetweenWorkspacesAndAbout() {
        machinePage()
        awaitTag("terminal:term1")
        compose.onAllNodesWithTag("terminal:elsewhere", useUnmergedTree = true).assertCountEquals(0)
        assertTrue("newest approval first", top("terminal:term2") < top("terminal:term1"))
        compose.onNodeWithText(Terminals.MACHINE_HINT, useUnmergedTree = true).assertExists()
        val term1 = fixture.terminals.first { it["id"]!!.jsonPrimitive.content == "term1" }
        compose.onNodeWithText("Approved ${AccessTokens.fullDate(term1["approvedAt"]!!.jsonPrimitive.content)}", useUnmergedTree = true).assertExists()
        compose.onNodeWithText("Last used 3m ago · Expires ${AccessTokens.fullDate(term1["expiresAt"]!!.jsonPrimitive.content)} · in 26 days",
            useUnmergedTree = true).assertExists()
        compose.onNodeWithText("Never used", substring = true, useUnmergedTree = true).assertExists()
        compose.onNodeWithTag("terminal:term1:revoke").assertTextContains("Revoke")
        // Workspaces, then Terminals, then About.
        compose.onNodeWithTag("machine-terminals", useUnmergedTree = true).performScrollTo()
        val terminals = topOf(Terminals.TITLE)
        assertTrue("under Workspaces", topOf(RunnerCopy.WORKSPACES) < terminals)
        assertTrue("over About", terminals < topOf(RunnerCopy.ABOUT))
    }

    @Test fun aMachineWithNoApprovedTerminalShowsNoSection() {
        fixture.terminals = listOf(terminal("elsewhere", 1, null, ManagementFixture.RUNNER_TWO))
        machinePage()
        compose.waitUntil(60_000) { reads() > 0 }
        await(RunnerCopy.ABOUT)
        compose.onAllNodesWithTag("machine-terminals", useUnmergedTree = true).assertCountEquals(0)
        compose.onAllNodesWithText(Terminals.MACHINE_HINT, useUnmergedTree = true).assertCountEquals(0)
    }

    @Test fun revokeAsksFirstWithCancelThenTheRevokedTerminalLeavesAndTheLastTakesTheSection() {
        machinePage()
        awaitTag("terminal:term1")
        compose.onNodeWithTag("terminal:term1:revoke").performScrollTo().performClick()
        compose.onNodeWithText("Revoke the terminal on dev-laptop?").assertExists()
        compose.onNodeWithText("It stops working at once. Typing orbit there asks you to approve it again.").assertExists()
        compose.onNode(hasText("Cancel") and hasClickAction() and hasAnyAncestor(isDialog())).performClick()
        compose.waitForIdle()
        assertTrue("Cancel revokes nothing", fixture.calls.none { it.startsWith("DELETE terminals") })
        val before = reads()
        compose.onNodeWithTag("terminal:term1:revoke").performScrollTo().performClick()
        compose.onNode(hasText("Revoke") and hasClickAction() and hasAnyAncestor(isDialog())).performClick()
        await("Terminal revoked")
        assertEquals(listOf("DELETE terminals/term1"), fixture.calls.filter { it.startsWith("DELETE terminals") })
        assertTrue("the list is read again after the revoke", reads() > before)
        awaitTagGone("terminal:term1")
        compose.onNodeWithTag("terminal:term2:revoke").performScrollTo().performClick()
        compose.onNode(hasText("Revoke") and hasClickAction() and hasAnyAncestor(isDialog())).performClick()
        awaitTagGone("machine-terminals")
    }

    @Test fun approvingACardOnThePageBringsItsTerminalIn() {
        fixture.terminals = emptyList()
        fixture.terminalRequests = listOf(buildJsonObject {
            put("id", "req1"); put("userCode", "7KQ-4MZ"); put("machineName", "dev-laptop"); put("runnerId", ManagementFixture.RUNNER)
            put("createdAt", now.minusSeconds(60).toString()); put("expiresAt", now.plusSeconds(540).toString())
        })
        machinePage()
        awaitTag("terminal-request:req1")
        compose.onAllNodesWithTag("machine-terminals", useUnmergedTree = true).assertCountEquals(0)
        // What the server mints on Approve.
        fixture.terminals = listOf(terminal("minted", 0, null))
        compose.onNodeWithTag("terminal-request:req1:approve", useUnmergedTree = true).performClick()
        awaitTag("terminal:minted")
        awaitTagGone("terminal-request:req1")
    }

    @Test fun settingsHasNoTerminalsRowAndTheOldRouteOpensMachinesAndModels() {
        val api = api()
        var route by mutableStateOf(OrbitRoute(Destination.SETTINGS, null))
        compose.setContent {
            SettingsScreen(api, route, 0, { route = it }, {}, logout = {}, changed = {}, workspaceDeleted = {},
                deviceAlerts = { true }, notifications = {}, about = {})
        }
        await("Access tokens")
        compose.onAllNodes(hasText("Terminals") and hasClickAction()).assertCountEquals(0)
        assertTrue("Settings reads no terminal list", fixture.calls.none { it == "GET terminals" })
        assertEquals(MachinesAndModels.TITLE, settingsTitle("terminals"))
        route = OrbitRoute(Destination.SETTINGS, "terminals")
        await(MachinesAndModels.MACHINES)
    }
}
