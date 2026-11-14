package io.orbitd.android.management

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.ui.OrbitTheme
import java.io.File
import java.time.Instant
import java.time.ZoneId
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * NATIVE frames of the runner page's Update card (docs/mocks/runner-update-drain board 4) on a phone: each phase drawn by the
 * production [UpdateCardView] from the runner JSON GET /runners returns, written under
 * `src/android/build/evidence/runner-update-card-android/` beside its semantics tree. The draining card's rows are asserted —
 * each turn's title and how long it has run, and that a row opens its session.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h891dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class RunnerUpdateCardShotsTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    private val utc = ZoneId.of("UTC")
    private val now = Instant.parse("2026-11-12T10:36:00Z").toEpochMilli()
    private fun ago(minutes: Long) = Instant.ofEpochMilli(now - minutes * 60_000).toString()

    private fun runner(selfUpdate: JsonObject, turns: JsonArray? = null) = buildJsonObject {
        put("id", "0199a0c4-7a1e-7c3e-9d4f-2a6b8c0d1e31"); put("name", "studio-mac"); put("version", "0.1.253"); put("online", true)
        put("selfUpdate", selfUpdate)
        turns?.let { put("updateTurns", it) }
    }

    private val output: File by lazy {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }.first { File(it, "src/android/settings.gradle.kts").isFile }
        File(root, "src/android/build/evidence/runner-update-card-android").also { it.mkdirs() }
    }

    private fun shot(name: String) {
        compose.waitForIdle()
        File(output, "$name-semantics.txt").writeText(compose.onRoot(useUnmergedTree = true).printToString())
        val view = compose.activity.window.decorView
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }

    private fun show(card: RunnerPage.UpdateCard, opened: MutableList<String> = mutableListOf()) {
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme(darkTheme = false) {
            Surface(color = MaterialTheme.colorScheme.background) {
                Column(Modifier.fillMaxWidth().padding(16.dp)) { UpdateCardView(card) { opened += it } }
            }
        } } }
        compose.waitForIdle()
    }

    @Test fun drainingListsTheTurnsItWaitsFor() {
        val card = RunnerPage.updateCard(runner(buildJsonObject {
            put("state", "waitingForIdle"); put("phase", "draining"); put("targetVersion", "0.1.254")
            put("availableSince", "2026-11-12T08:58:00Z"); put("drainingSince", ago(38)); put("turnsInFlight", 2); put("turnsAtDrain", 8)
        }, buildJsonArray {
            addJsonObject { put("id", "34w8a1Backfill00000001"); put("title", "Backfill missing shard rows"); put("startedAt", ago(112)) }
            addJsonObject { put("id", "34w8a1Metrics000000002"); put("title", "Why are 11-08 metrics zero"); put("startedAt", ago(47)) }
        }), now, utc)!!
        val opened = mutableListOf<String>()
        show(card, opened)
        compose.onNodeWithText("Updating to 0.1.254", useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithText("Not taking new work", useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithText("Waiting for 2 of 8 turns · 38 min", useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithText("Backfill missing shard rows", useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithText("running 1 h 52 min", useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithText("Why are 11-08 metrics zero", useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithText("running 47 min", useUnmergedTree = true).assertIsDisplayed()
        // The longest-running turn is the first row, as the server orders them.
        val rows = compose.onAllNodesWithTag("runner-update-turn", useUnmergedTree = true).fetchSemanticsNodes()
        assertEquals(2, rows.size)
        assertTrue(rows[0].boundsInRoot.top < rows[1].boundsInRoot.top)
        shot("1-draining")
        compose.onNodeWithText("Backfill missing shard rows", useUnmergedTree = true).performClick()
        compose.waitForIdle()
        assertEquals(listOf("34w8a1Backfill00000001"), opened)
    }

    @Test fun theOtherPhases() {
        show(RunnerPage.updateCard(runner(buildJsonObject {
            put("state", "waitingForIdle"); put("phase", "available"); put("targetVersion", "0.1.254")
        }), now, utc)!!)
        compose.onNodeWithText("0.1.254 is available", useUnmergedTree = true).assertIsDisplayed()
        shot("2-available")

        show(RunnerPage.updateCard(runner(buildJsonObject {
            put("state", "waitingForIdle"); put("phase", "postponed"); put("targetVersion", "0.1.254"); put("postponedUntil", "2026-11-12T12:57:00Z")
        }), now, utc)!!)
        compose.onNodeWithText("0.1.254 postponed until 12:57", useUnmergedTree = true).assertIsDisplayed()
        shot("3-postponed")

        show(RunnerPage.updateCard(runner(buildJsonObject {
            put("state", "enabled"); put("phase", "restarting"); put("targetVersion", "0.1.254")
        }), now, utc)!!)
        compose.onNodeWithText("Restarting into 0.1.254…", useUnmergedTree = true).assertIsDisplayed()
        compose.onAllNodesWithTag("runner-update-turn", useUnmergedTree = true).assertCountEquals(0)
        shot("4-restarting")
    }
}
