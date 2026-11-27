package io.orbitd.android.management

import android.content.ComponentName
import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.layout.padding
import io.orbitd.android.cards.NeedsYouToastCard
import io.orbitd.android.core.auth.AuthState
import io.orbitd.android.core.cards.TerminalRequest
import io.orbitd.android.ui.OrbitTheme
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
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

/**
 * NATIVE frames of terminal approvals on a phone, against board docs/mocks/waiting-on-you-removal/02-terminal-approvals.html: Machines &
 * models with one and two requests in Needs you, the card lit as the bar's line lands on it, a machine's own page, and the needs-you
 * notice for a new request and the machine page it opens. Each frame is the production composable over the management fixture's wire. Written, with its
 * semantics tree, under `TERMINAL_SHOTS_DIR` when that is set; drawn and checked either way.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = ManagementShellApplication::class, qualifiers = "w411dp-h891dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class TerminalRequestsShotsTest {
    @get:Rule(order = 0) val host = object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }
    @get:Rule(order = 1) val compose = createAndroidComposeRule<ComponentActivity>()
    private val fixture = ManagementFixture
    private val output: File? = System.getenv("TERMINAL_SHOTS_DIR")?.let { File(it).also(File::mkdirs) }

    private val first = "01a0d6a9-d763-70e1-b4cf-8793e971b5f1"
    private val second = "01a0d6a9-d763-70e1-b4cf-8793e971b5f2"
    private fun request(id: String, code: String, minutesAgo: Long) = buildJsonObject {
        put("id", id); put("userCode", code); put("machineName", "dev-laptop"); put("runnerId", fixture.RUNNER)
        put("createdAt", Instant.now().minusSeconds(minutesAgo * 60).toString())
        put("expiresAt", Instant.now().plusSeconds(600 - minutesAgo * 60).toString())
    }

    @Before fun start() { fixture.reset() }

    private fun api(): ManagementApi {
        val session = fixture.session()
        runBlocking { fixture.signIn(session) }
        return ManagementApi(session, (session.state.value as AuthState.SignedIn).handle)
    }

    private fun show(content: @androidx.compose.runtime.Composable () -> Unit) {
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme(darkTheme = false) {
            Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) { content() }
        } } }
        compose.waitForIdle()
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

    @Test fun machinesAndModels() {
        fixture.terminalRequests = listOf(request(first, "7KQ-4MZ", 3))
        val api = api()
        show { RunnerScreen(api, null, null, 0, {}, {}, {}) }
        awaitTag("terminal-request:$first")
        compose.waitUntil(60_000) { compose.onAllNodesWithText(MachinesAndModels.MACHINES).fetchSemanticsNodes().isNotEmpty() }
        shot("android-machines-1")
    }

    @Test fun machinesAndModelsWithTwoTheOldestLit() {
        fixture.terminalRequests = listOf(request(first, "7KQ-4MZ", 3), request(second, "R2T-9PX", 1))
        val api = api()
        show { RunnerScreen(api, null, TerminalNeedsYou.record(first), 0, {}, {}, {}) }
        awaitTag("terminal-request:$first:lit")
        awaitTag("terminal-request:$second")
        shot("android-machines-2-lit")
    }

    @Test fun aMachinesOwnPage() {
        fixture.terminalRequests = listOf(request(first, "7KQ-4MZ", 3))
        val api = api()
        show { RunnerScreen(api, fixture.RUNNER, null, 0, {}, {}, {}) }
        awaitTag("terminal-request:$first")
        shot("android-machine-page")
    }

    /** The notice (the owner, 2026-11-16: board 02 ③ as a toast under needs-you-capsule/12-once), in the toast host's column. */
    @Test fun theTerminalNotice() {
        val r = TerminalRequest(first, "7KQ-4MZ", "dev-laptop", fixture.RUNNER,
            Instant.now().minusSeconds(5).toString(), Instant.now().plusSeconds(595).toString())
        show {
            Column(Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
                NeedsYouToastCard(TerminalNeedsYou.toast(r), dismiss = {}) {}
            }
        }
        compose.onNodeWithTag("needs-you-toast-title", useUnmergedTree = true).assertTextEquals("Approve a terminal")
        compose.onNodeWithTag("needs-you-toast-line", useUnmergedTree = true).assertTextEquals("dev-laptop · code 7KQ-4MZ")
        compose.onNodeWithTag("needs-you-toast-glyph:TERMINAL", useUnmergedTree = true).assertExists()
        shot("android-terminal-toast")
    }

    /** Where a press on the notice lands: the machine's own page, its Terminals to approve, the card lit. */
    @Test fun theMachinePageTheNoticeOpens() {
        fixture.terminalRequests = listOf(request(first, "7KQ-4MZ", 0))
        val api = api()
        val route = TerminalNeedsYou.machineRoute(TerminalRequest(first, "7KQ-4MZ", "dev-laptop", fixture.RUNNER,
            Instant.now().toString(), Instant.now().plusSeconds(600).toString()))
        show { RunnerScreen(api, route.id, route.recordId, 0, {}, {}, {}) }
        awaitTag("terminal-request:$first:lit")
        compose.onNodeWithText(TerminalNeedsYou.TO_APPROVE).assertExists()
        shot("android-machine-page-from-toast")
    }
}
