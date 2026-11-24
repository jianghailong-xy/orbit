package io.orbitd.android.management

import android.content.ComponentName
import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.ui.OrbitTheme
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.time.Instant
import java.time.temporal.ChronoUnit

/**
 * NATIVE frames of a machine page's approved Terminals on a phone, against board docs/mocks/terminals-on-machine-page/01-board.html:
 * dev-laptop with two approved terminals (and one waiting under its title), a machine with none, and dev-laptop after a Revoke. A
 * tall phone, so the whole page is one frame. Each is the production page over the management fixture's wire. Written, with its
 * semantics tree, under `TERMINAL_SHOTS_DIR` when that is set; drawn and checked either way.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ManagementShellApplication::class, qualifiers = "w411dp-h2600dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class MachineTerminalsShotsTest {
    @get:Rule(order = 0) val host = object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }
    @get:Rule(order = 1) val compose = createAndroidComposeRule<ComponentActivity>()
    private val fixture = ManagementFixture
    private val output: File? = System.getenv("TERMINAL_SHOTS_DIR")?.let { File(it).also(File::mkdirs) }
    private val now = Instant.now()

    private fun terminal(id: String, approvedDaysAgo: Long, lastUsedAt: Instant?) = buildJsonObject {
        put("id", id); put("machineName", "dev-laptop"); put("runnerId", ManagementFixture.RUNNER)
        put("createdAt", now.minus(approvedDaysAgo, ChronoUnit.DAYS).toString())
        put("approvedAt", now.minus(approvedDaysAgo, ChronoUnit.DAYS).toString())
        put("lastUsedAt", lastUsedAt?.toString()?.let(::JsonPrimitive) ?: JsonNull)
        put("expiresAt", now.plus(30 - approvedDaysAgo, ChronoUnit.DAYS).toString())
    }

    @Before fun start() {
        fixture.reset()
        fixture.terminals = listOf(terminal("term-old", 4, now.minusSeconds(3 * 3600)), terminal("term-new", 1, null))
        fixture.terminalRequests = listOf(buildJsonObject {
            put("id", "req1"); put("userCode", "7KQ-4MZ"); put("machineName", "dev-laptop"); put("runnerId", ManagementFixture.RUNNER)
            put("createdAt", now.minusSeconds(60).toString()); put("expiresAt", now.plusSeconds(540).toString())
        })
    }

    private fun page(runner: String) {
        val session = fixture.session()
        runBlocking { fixture.signIn(session) }
        val api = ManagementApi(session, (session.state.value as AuthState.SignedIn).handle)
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme(darkTheme = false) {
            Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) { RunnerScreen(api, runner, null, 0, {}, {}, {}) }
        } } }
        compose.waitUntil(60_000) { compose.onAllNodesWithText(RunnerCopy.ABOUT).fetchSemanticsNodes().isNotEmpty() }
    }

    private fun shot(name: String) {
        compose.waitForIdle()
        val dir = output ?: return
        File(dir, "$name-semantics.txt").writeText(compose.onRoot(useUnmergedTree = true).printToString())
        val view = compose.activity.window.decorView
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        File(dir, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }

    private fun awaitTag(tag: String) =
        compose.waitUntil(60_000) { compose.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty() }
    private fun awaitTagGone(tag: String) =
        compose.waitUntil(60_000) { compose.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().isEmpty() }

    @Test fun approved() {
        page(ManagementFixture.RUNNER)
        awaitTag("terminal:term-old")
        awaitTag("terminal-request:req1")
        shot("android-terminals-1-approved")
    }

    @Test fun none() {
        fixture.secondRunner = true
        page(ManagementFixture.RUNNER_TWO)
        compose.waitUntil(60_000) { fixture.calls.contains("GET terminals") }
        compose.onAllNodesWithTag("machine-terminals", useUnmergedTree = true).assertCountEquals(0)
        shot("android-terminals-2-none")
    }

    @Test fun afterRevoke() {
        page(ManagementFixture.RUNNER)
        awaitTag("terminal:term-old")
        compose.onNodeWithTag("terminal:term-old:revoke").performClick()
        compose.onNodeWithText("Revoke the terminal on dev-laptop?").assertExists()
        compose.onNode(hasText("Revoke") and hasClickAction() and hasAnyAncestor(isDialog())).performClick()
        awaitTagGone("terminal:term-old")
        compose.waitUntil(60_000) { compose.onAllNodesWithText("Terminal revoked").fetchSemanticsNodes().isNotEmpty() }
        shot("android-terminals-3-after-revoke")
    }
}
