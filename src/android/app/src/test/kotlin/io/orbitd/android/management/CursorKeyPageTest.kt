package io.orbitd.android.management

import android.content.ComponentName
import androidx.activity.ComponentActivity
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
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
import java.time.Instant

/**
 * A Cursor User API Key on Infrastructure, over the controlled server (the owner's board, iOS 4): its row in API keys runs on Cursor CLI
 * alone, on Auto, and ends with Rejected once Cursor refused it; its page says what it works with and whose plan it bills, what Cursor
 * answered its last check, Check Again where that was no yes (P2 follow-up's POST providers/mine/:id/key-check), and the key itself.
 * Adding or changing a key happens on the web.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ManagementShellApplication::class)
class CursorKeyPageTest {
    @get:Rule(order = 0) val host = object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }
    @get:Rule(order = 1) val compose = createComposeRule()
    private val fixture = ManagementFixture
    private var revision by mutableLongStateOf(0L)
    private val key = "0198f3a2-cccc-7000-8000-00000000000c"
    private val checked = Instant.now().minusSeconds(4 * 60).toString()

    private fun mine(state: String?) = """[{"id":"$key","slug":"cursor-api-2","label":"Cursor 2","runtime":"cursor","presetSlug":"cursor-api",
        "baseUrl":"https://api2.cursor.sh","hasApiKey":true,"enabled":true,"models":[],"defaultModel":"","engines":["cursor"],
        "keyCheckState":${state?.let { "\"$it\"" } ?: "null"},"keyCheckedAt":${state?.let { "\"$checked\"" } ?: "null"}}]"""

    @Before fun start() {
        fixture.reset()
        fixture.providersMine = mine("INVALID")
    }

    private fun infrastructure(record: String?, opened: MutableList<OrbitRoute> = mutableListOf()) {
        val session = fixture.session()
        runBlocking { fixture.signIn(session) }
        val api = ManagementApi(session, (session.state.value as AuthState.SignedIn).handle)
        compose.setContent { InfrastructureSettings(api, revision, record, { opened += it }, {}) }
    }
    private fun await(text: String) = compose.waitUntil(60_000) { compose.onAllNodesWithText(text, substring = true).fetchSemanticsNodes().isNotEmpty() }

    /** iOS 4 ①②: Auto, Cursor CLI alone, Rejected at its end; it opens its own page. */
    @Test fun aCursorKeysRowRunsOnCursorCliAloneAndSaysRejected() {
        val opened = mutableListOf<OrbitRoute>()
        infrastructure(null, opened)
        await("Cursor 2")
        compose.onNodeWithText("Auto", useUnmergedTree = true).assertExists()
        compose.onNodeWithText("Cursor CLI", useUnmergedTree = true).assertExists()
        await("Rejected")
        assertFalse("no DeepSeek balance is asked for a Cursor key", fixture.calls.any { it.endsWith("/balance") })
        compose.onNode(hasTestTag("api-key:cursor-api-2") and hasClickAction()).performScrollTo().performClick()
        compose.runOnIdle { assertEquals(listOf(OrbitRoute(Destination.SETTINGS, "infrastructure", recordId = "cursor-key:$key")), opened) }
    }

    /** iOS 4 ③⑤: Works with Cursor CLI, billed to the key's own plan; the last check Rejected, Cursor's words, and Check Again — whose
     * answer, kept on the key, is the page's next reading. */
    @Test fun aRefusedKeysPageQuotesCursorAndChecksAgain() {
        fixture.onKeyCheck = { fixture.providersMine = mine("VALID").replace(checked, Instant.now().toString()) }
        infrastructure("cursor-key:$key")
        await("Billed to this key’s Cursor plan")
        // The shell titles the page by the key's name, as iOS does.
        assertEquals("Cursor 2", settingsTitle("infrastructure", "cursor-key:$key"))
        await("Pick it for a Cursor CLI session in the composer’s model menu → Provider. It runs no other engine.")
        compose.onNodeWithTag("cursor-key-last-check").assertExists()
        await("Rejected · 4 min ago")
        await("Cursor said “The provided API key is invalid.” Paste a new key on the web, then check again.")
        await("Cursor API")
        await("api2.cursor.sh")
        await("Adding or changing a key happens on the web. Turning it off there stops it on Cursor CLI.")
        compose.onNodeWithTag("cursor-key-check-again").performScrollTo().performClick()
        compose.waitUntil(60_000) { fixture.calls.contains("POST providers/mine/$key/key-check") }
        await("Valid · Just now")
        await("A runner with Cursor CLI checks the key with Cursor (no request is spent).")
        compose.onAllNodesWithTag("cursor-key-check-again").assertCountEquals(0)
    }

    /** A check that could not be had — no runner to ask — is not kept on the key: the page says why in the server's words. */
    @Test fun aCheckNoRunnerCouldAskSaysWhy() {
        fixture.providersMine = mine(null)
        fixture.keyCheckAnswer = """{"ok":false,"keyCheck":"NO_RUNNER","message":"No runner of yours can check Cursor keys right now.","recorded":false,
            "keyCheckState":null,"keyCheckedAt":null}"""
        infrastructure("cursor-key:$key")
        await("Not checked yet")
        compose.onNodeWithTag("cursor-key-check-again").performScrollTo().performClick()
        await("No runner of yours can check Cursor keys right now.")
        await("Not checked yet")
    }
}
