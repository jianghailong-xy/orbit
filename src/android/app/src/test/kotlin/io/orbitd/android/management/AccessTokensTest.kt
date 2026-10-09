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

/** Settings → Access tokens over the controlled server (iOS 90b80b42f, 86203ffb0; A13-7): the row's count, the page's two tabs and
 * lines, revoking only after asking — with Cancel beside it — and never issuing a token. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ManagementShellApplication::class)
class AccessTokensTest {
    @get:Rule(order = 0) val host = object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }
    @get:Rule(order = 1) val compose = createComposeRule()
    private val fixture = ManagementFixture
    private var revision by mutableLongStateOf(0L)
    private val now = Instant.now()

    private fun token(id: String, name: String, hint: String, state: String = "ACTIVE", scopes: List<String>, workspaceIds: List<String> = emptyList(),
        workspaces: List<Pair<String, String>> = emptyList(), expiresAt: Instant? = null, lastUsedAt: Instant? = null, lastUsedIp: String? = null,
        revokedAt: Instant? = null, revokedReason: String? = null) = buildJsonObject {
        put("id", id); put("name", name); put("tokenHint", hint); put("state", state); put("createdVia", "WEB"); put("createdAt", now.minus(30, ChronoUnit.DAYS).toString())
        put("scopes", JsonArray(scopes.map(::JsonPrimitive))); put("workspaceIds", JsonArray(workspaceIds.map(::JsonPrimitive)))
        put("workspaces", JsonArray(workspaces.map { (wid, wname) -> buildJsonObject { put("id", wid); put("name", wname) } }))
        put("expiresAt", expiresAt?.toString()?.let(::JsonPrimitive) ?: JsonNull)
        put("lastUsedAt", lastUsedAt?.toString()?.let(::JsonPrimitive) ?: JsonNull); put("lastUsedIp", lastUsedIp?.let(::JsonPrimitive) ?: JsonNull)
        put("revokedAt", revokedAt?.toString()?.let(::JsonPrimitive) ?: JsonNull); put("revokedReason", revokedReason?.let(::JsonPrimitive) ?: JsonNull)
    }

    private val everything = listOf("tasks:read", "tasks:write", "projects:read", "projects:write", "sessions:read", "sessions:write",
        "workspaces:read", "workspaces:write", "runners:read", "wiki:read", "wiki:write", "events:read")

    @Before fun start() {
        fixture.reset()
        fixture.accessTokens = listOf(
            token("t1", "laptop", "k3Fq", scopes = everything, lastUsedAt = now.minusSeconds(12_000), lastUsedIp = "203.0.113.7"),
            token("t2", "ci", "Zz90", scopes = listOf("tasks:read", "tasks:write", "sessions:read"), workspaceIds = listOf("w1", "w2"),
                workspaces = listOf("w1" to "orbit"), expiresAt = now.plus(90, ChronoUnit.DAYS)),
            token("t3", "old phone", "Ab12", state = "REVOKED", scopes = everything, revokedAt = now.minus(2, ChronoUnit.DAYS), revokedReason = "ADMIN"),
            token("t4", "spike", "Cd34", state = "EXPIRED", scopes = everything.filter { it.endsWith(":read") }, expiresAt = now.minus(3, ChronoUnit.DAYS)))
    }

    private fun api(): ManagementApi {
        val session = fixture.session()
        runBlocking { fixture.signIn(session) }
        return ManagementApi(session, (session.state.value as AuthState.SignedIn).handle)
    }
    private fun await(text: String) = compose.waitUntil(60_000) { compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty() }
    private fun settings(page: String?, opened: MutableList<OrbitRoute> = mutableListOf()) {
        val api = api()
        var route by mutableStateOf(OrbitRoute(Destination.SETTINGS, page))
        compose.setContent {
            SettingsScreen(api, route, revision, { opened += it; route = it }, {}, logout = {}, changed = {}, workspaceDeleted = {},
                deviceAlerts = { true }, notifications = {}, about = {})
        }
    }

    @Test fun settingsHasAnAccessTokensRowCountingTheWorkingOnes() {
        val opened = mutableListOf<OrbitRoute>()
        settings(null, opened)
        await("Access tokens")
        await("2 active")
        compose.onNode(hasText("Access tokens") and hasClickAction()).performScrollTo().performClick()
        compose.runOnIdle { assertEquals(listOf(OrbitRoute(Destination.SETTINGS, "access-tokens")), opened) }
        await("Revoked & expired 2")
        assertEquals("Access tokens", settingsTitle("access-tokens"))
    }

    @Test fun thePageFilesTokensByWhetherTheyStillWorkInTheWebsWords() {
        settings("access-tokens")
        await("Active 2")
        compose.onNodeWithText("Revoked & expired 2").assertExists()
        compose.onNodeWithText("Let your scripts and the orbit CLI use the Orbit API as you, with only the access you give each token. " +
            "Treat a token like a password. New tokens are created in Settings → Access tokens on the web.").assertExists()
        compose.onNodeWithText("orbit_pat_…k3Fq", useUnmergedTree = true).assertExists()
        compose.onNodeWithText("Read & write · everything", useUnmergedTree = true).assertExists()
        compose.onNodeWithText("Never expires", useUnmergedTree = true).assertExists()
        compose.onNodeWithText("Last used 3h 20m ago · 203.0.113.7", useUnmergedTree = true).assertExists()
        compose.onNodeWithText("Tasks: read & write · Sessions: read · in orbit, a deleted workspace", useUnmergedTree = true).assertExists()
        compose.onNodeWithText("in 90 days", substring = true, useUnmergedTree = true).assertExists()
        compose.onNodeWithText("Never used", useUnmergedTree = true).assertExists()
        // The apps never issue a token.
        compose.onAllNodes(hasText("New token", substring = true) and hasClickAction()).assertCountEquals(0)
        compose.onAllNodes(hasText("Create", substring = true) and hasClickAction()).assertCountEquals(0)
        compose.onNode(hasText("Revoked & expired 2") and hasClickAction()).performClick()
        compose.onNodeWithText("Revoked by an administrator", substring = true, useUnmergedTree = true).assertExists()
        compose.onNodeWithText("Expired ", substring = true, useUnmergedTree = true).assertExists()
        compose.onNodeWithText("Read-only · everything", useUnmergedTree = true).assertExists()
        // A token that stopped has nothing left to revoke.
        compose.onAllNodesWithContentDescription("More for old phone").assertCountEquals(0)
    }

    @Test fun revokingAsksFirstWithCancelThenTheListIsReadAgain() {
        settings("access-tokens")
        await("Active 2")
        compose.onNodeWithContentDescription("More for laptop").performClick()
        compose.onNode(hasText("Revoke") and hasClickAction()).performClick()
        compose.onNodeWithText("Revoke “laptop”?").assertExists()
        compose.onNodeWithText("Anything using it stops working at once. This can’t be undone.").assertExists()
        compose.onNode(hasText("Cancel") and hasClickAction() and hasAnyAncestor(isDialog())).performClick()
        compose.waitForIdle()
        assertTrue("Cancel revokes nothing", fixture.calls.none { it.startsWith("DELETE") })
        val reads = fixture.calls.count { it == "GET access-tokens" }
        compose.onNodeWithContentDescription("More for laptop").performClick()
        compose.onNode(hasText("Revoke") and hasClickAction()).performClick()
        compose.onNode(hasText("Revoke") and hasClickAction() and hasAnyAncestor(isDialog())).performClick()
        await("Token revoked")
        assertEquals(listOf("DELETE access-tokens/t1"), fixture.calls.filter { it.startsWith("DELETE") })
        assertTrue("the list is read again after the revoke", fixture.calls.count { it == "GET access-tokens" } > reads)
        await("Active 1")
        compose.onNodeWithText("Revoked & expired 3").assertExists()
    }

    @Test fun aListThatCouldNotBeReadSaysWhyAndOffersRetryNeverNoTokens() {
        fixture.accessTokensFail = true
        settings("access-tokens")
        await("Couldn’t load your tokens:")
        compose.onNodeWithText("token list failed", substring = true).assertExists()
        compose.onAllNodesWithText("No active tokens", substring = true).assertCountEquals(0)
        fixture.accessTokensFail = false
        compose.onNode(hasText("Retry") and hasClickAction()).performClick()
        await("orbit_pat_…k3Fq")
    }
}
