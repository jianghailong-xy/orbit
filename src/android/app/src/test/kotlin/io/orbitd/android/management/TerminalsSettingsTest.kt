package io.orbitd.android.management

import android.content.ComponentName
import androidx.activity.ComponentActivity
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
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

/** Settings → Terminals over the controlled server (iOS `TerminalsSettingsPage`): the Account row after Access tokens with how many are
 * signed in, the page's rows and lines, Revoke only after asking — with Cancel beside it — the list read again after it so the revoked
 * terminal is gone, and `terminals.changed` reading it again. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ManagementShellApplication::class)
class TerminalsSettingsTest {
    @get:Rule(order = 0) val host = object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }
    @get:Rule(order = 1) val compose = createComposeRule()
    private val fixture = ManagementFixture
    private var changed by mutableLongStateOf(0L)
    private val now = Instant.now()

    private fun terminal(id: String, machine: String, lastUsedAt: Instant?) = buildJsonObject {
        put("id", id); put("machineName", machine); put("runnerId", ManagementFixture.RUNNER)
        put("createdAt", now.minus(2, ChronoUnit.DAYS).toString()); put("approvedAt", now.minus(2, ChronoUnit.DAYS).toString())
        put("lastUsedAt", lastUsedAt?.toString()?.let(::JsonPrimitive) ?: JsonNull)
        put("expiresAt", now.plus(28, ChronoUnit.DAYS).toString())
    }

    @Before fun start() {
        fixture.reset()
        fixture.terminals = listOf(terminal("term1", "dev-laptop", now.minusSeconds(180)), terminal("term2", "build-box", null))
    }

    private fun settings(page: String?, opened: MutableList<OrbitRoute> = mutableListOf()) {
        val session = fixture.session()
        runBlocking { fixture.signIn(session) }
        val api = ManagementApi(session, (session.state.value as AuthState.SignedIn).handle)
        var route by mutableStateOf(OrbitRoute(Destination.SETTINGS, page))
        compose.setContent {
            SettingsScreen(api, route, 0, { opened += it; route = it }, {}, logout = {}, changed = {}, workspaceDeleted = {},
                deviceAlerts = { true }, notifications = {}, about = {}, terminalsChanged = changed)
        }
    }
    private fun await(text: String) = compose.waitUntil(60_000) { compose.onAllNodesWithText(text, substring = true, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
    private fun awaitGone(text: String) = compose.waitUntil(60_000) { compose.onAllNodesWithText(text, useUnmergedTree = true).fetchSemanticsNodes().isEmpty() }
    private fun reads() = fixture.calls.count { it == "GET terminals" }

    @Test fun settingsHasATerminalsRowAfterAccessTokensCountingTheSignedInOnes() {
        val opened = mutableListOf<OrbitRoute>()
        settings(null, opened)
        await("2 signed in")
        val row = compose.onNode(hasText("Terminals") and hasClickAction()).performScrollTo()
        // Read together, after the one scroll: Access tokens, then Terminals, then Change password.
        // Where each row starts, unclipped by the screen's edge.
        val (tokens, terminals, password) = listOf("Access tokens", "Terminals", "Change password")
            .map { compose.onNode(hasText(it) and hasClickAction()).fetchSemanticsNode().positionInRoot.y }
        assertTrue("Terminals sits under Access tokens ($tokens, $terminals)", terminals > tokens)
        assertTrue("and over Change password ($terminals, $password)", terminals < password)
        row.performClick()
        compose.runOnIdle { assertEquals(listOf(OrbitRoute(Destination.SETTINGS, "terminals")), opened) }
        assertEquals("Terminals", settingsTitle("terminals"))
        await("dev-laptop")
    }

    @Test fun noTerminalIsNone() {
        fixture.terminals = emptyList()
        settings(null)
        compose.waitUntil(60_000) { reads() > 0 }
        compose.waitUntil(60_000) { runCatching { compose.onNode(hasText("Terminals") and hasClickAction()).assertTextContains("None") }.isSuccess }
    }

    @Test fun thePageListsEachTerminalsMachineAndLines() {
        settings("terminals")
        await("dev-laptop")
        compose.onNodeWithText("Terminals where you typed orbit and approved it. Each one can start sessions on its machine and answer " +
            "their approval cards until it expires.").assertExists()
        compose.onNodeWithText("build-box", useUnmergedTree = true).assertExists()
        compose.onNodeWithText("Last used 3m ago", useUnmergedTree = true).assertExists()
        compose.onNodeWithText("Never used", useUnmergedTree = true).assertExists()
        compose.onAllNodesWithText("Approved ${AccessTokens.fullDate(now.minus(2, ChronoUnit.DAYS).toString())}", useUnmergedTree = true).assertCountEquals(2)
        compose.onAllNodesWithText("Expires ${AccessTokens.fullDate(now.plus(28, ChronoUnit.DAYS).toString())} · in 28 days", useUnmergedTree = true)
            .assertCountEquals(2)
        compose.onNodeWithTag("terminal:term1:revoke").assertTextContains("Revoke")
    }

    @Test fun revokeAsksFirstWithCancelThenTheRevokedTerminalLeavesTheList() {
        settings("terminals")
        await("dev-laptop")
        compose.onNodeWithTag("terminal:term1:revoke").performClick()
        compose.onNodeWithText("Revoke the terminal on dev-laptop?").assertExists()
        compose.onNodeWithText("It stops working at once. Typing orbit there asks you to approve it again.").assertExists()
        compose.onNode(hasText("Cancel") and hasClickAction() and hasAnyAncestor(isDialog())).performClick()
        compose.waitForIdle()
        assertTrue("Cancel revokes nothing", fixture.calls.none { it.startsWith("DELETE") })
        val before = reads()
        compose.onNodeWithTag("terminal:term1:revoke").performClick()
        compose.onNode(hasText("Revoke") and hasClickAction() and hasAnyAncestor(isDialog())).performClick()
        await("Terminal revoked")
        assertEquals(listOf("DELETE terminals/term1"), fixture.calls.filter { it.startsWith("DELETE") })
        assertTrue("the list is read again after the revoke", reads() > before)
        awaitGone("dev-laptop")
        compose.onNodeWithText("build-box", useUnmergedTree = true).assertExists()
        compose.onNodeWithTag("terminal:term2:revoke").performClick()
        compose.onNode(hasText("Revoke") and hasClickAction() and hasAnyAncestor(isDialog())).performClick()
        await("No terminals are signed in.")
    }

    @Test fun terminalsChangedReadsTheListAgain() {
        settings("terminals")
        await("dev-laptop")
        compose.waitForIdle()
        val before = reads()
        fixture.terminals = fixture.terminals + terminal("term3", "ci-runner", null)
        changed = 1
        await("ci-runner")
        assertTrue(reads() > before)
    }
}
