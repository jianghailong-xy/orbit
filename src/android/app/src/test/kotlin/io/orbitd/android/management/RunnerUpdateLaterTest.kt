package io.orbitd.android.management

import android.content.ComponentName
import androidx.activity.ComponentActivity
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import io.orbitd.android.directory.QueuedGate
import io.orbitd.android.directory.QueuedRunnerUpdate
import io.orbitd.android.reader.RunnerUpdatingFoot
import io.orbitd.android.reader.RunnerUpdatingQueued
import io.orbitd.android.ui.OrbitTheme
import java.io.File
import java.time.Instant
import java.time.ZoneId
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** Later (docs/runner-update-drain-design.md §2, D1; board 5's sheet, as iOS draws it): the times, the sheet, the request, the words. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = io.orbitd.android.TestOrbitApplication::class)
class RunnerUpdateLaterTest {
    @get:Rule(order = 0) val host = object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }
    @get:Rule(order = 1) val compose = createComposeRule()

    private val shanghai = ZoneId.of("Asia/Shanghai")
    private val now = Instant.parse("2026-11-12T03:57:00Z") // 11:57 in Shanghai

    @Test fun anHourTheNextTwoAMAndNineTomorrowInTheReadersZone() {
        assertEquals(Instant.parse("2026-11-12T04:57:00Z"), RunnerUpdateLater.until(RunnerUpdateLater.Choice.HOUR, now, shanghai))
        assertEquals(Instant.parse("2026-11-12T18:00:00Z"), RunnerUpdateLater.until(RunnerUpdateLater.Choice.TONIGHT, now, shanghai))
        assertEquals(Instant.parse("2026-11-13T01:00:00Z"), RunnerUpdateLater.until(RunnerUpdateLater.Choice.TOMORROW, now, shanghai))
        // After midnight tonight is still today's 02:00 until it passes; tomorrow is the next calendar day.
        val halfPastMidnight = Instant.parse("2026-11-12T16:30:00Z")
        assertEquals(Instant.parse("2026-11-12T18:00:00Z"), RunnerUpdateLater.until(RunnerUpdateLater.Choice.TONIGHT, halfPastMidnight, shanghai))
        assertEquals(Instant.parse("2026-11-14T01:00:00Z"), RunnerUpdateLater.until(RunnerUpdateLater.Choice.TOMORROW, halfPastMidnight, shanghai))
        assertEquals(Instant.parse("2026-11-13T18:00:00Z"),
            RunnerUpdateLater.until(RunnerUpdateLater.Choice.TONIGHT, Instant.parse("2026-11-12T18:00:00Z"), shanghai))
    }

    @Test fun theSheetReadsAsBoardFiveAndTheRequestCarriesTheZone() {
        assertEquals(listOf("In 1 Hour", "Tonight at 02:00", "Tomorrow at 09:00"), RunnerUpdateLater.sheetRows(now, shanghai).map { it.label })
        assertEquals("Postpone the 0.1.254 update on studio-mac. It takes work again right away.",
            RunnerUpdateLater.sheetMessage("0.1.254", "studio-mac"))
        val body = RunnerUpdateLater.body(Instant.parse("2026-11-12T18:00:00Z"), shanghai)
        assertEquals(JsonPrimitive("2026-11-12T18:00:00Z"), body["until"])
        assertEquals(JsonPrimitive("Asia/Shanghai"), body["timeZone"])
        assertEquals(listOf("runners", "r1", "self-update", "postpone"), RunnerUpdateLater.path("r1"))
    }

    /** The words are OrbitKit's (RunnerPageCopy, itself held to the web's runnerCopy.ts, and RunnerUpdateLater). */
    @Test fun theWordsAreIOSs() {
        var dir: File? = File("").absoluteFile
        var copy: String? = null
        var later: String? = null
        while (dir != null && (copy == null || later == null)) {
            File(dir, "src/macos/OrbitKit/Sources/OrbitKit/App/RunnerPageCopy.swift").takeIf { it.isFile }?.let { copy = it.readText() }
            File(dir, "src/macos/OrbitKit/Sources/OrbitKit/App/RunnerUpdateLater.swift").takeIf { it.isFile }?.let { later = it.readText() }
            dir = dir.parentFile
        }
        val flat = copy!!.replace(Regex("\\s+"), " ")
        for (words in listOf(RunnerUpdateLater.LATER, RunnerUpdateLater.CHANGE, RunnerUpdateLater.UPDATE_NOW, RunnerUpdateLater.UPDATE_NOW_CONFIRM,
            RunnerUpdateLater.UPDATE_NOW_CONFIRM_BODY, RunnerUpdateLater.POSTPONE_FAILED)) {
            assertTrue("RunnerPageCopy.swift does not say \"$words\"", flat.contains("\"$words\""))
        }
        assertTrue(flat.contains("\"Update to \\(version) now?\""))
        assertTrue(later!!.contains("public static let SHEET_HOUR = \"${RunnerUpdateLater.SHEET_HOUR}\""))
        assertTrue(later!!.contains("\"Tonight at \\(clock)\"") && later!!.contains("\"Tomorrow at \\(clock)\""))
        assertTrue(later!!.contains("return \"Postpone \\(update)\\(on). It takes work again right away.\""))
    }

    @Test fun laterRaisesTheSheetAndAPickPostponesUntilThatTime() {
        val picked = mutableListOf<Instant>()
        compose.setContent { OrbitTheme { RunnerUpdateLaterButton("0.1.254", "studio-mac", { picked += it; null }, now = { now }) } }
        compose.onNodeWithTag("runner-update-later").assertTextEquals("Later…").performClick()
        compose.waitForIdle()
        compose.onNodeWithTag("runner-update-later-sheet:message", useUnmergedTree = true)
            .assertTextEquals("Postpone the 0.1.254 update on studio-mac. It takes work again right away.")
        compose.onNodeWithTag("runner-update-later:tomorrow").performClick()
        compose.waitForIdle()
        assertEquals(listOf(RunnerUpdateLater.until(RunnerUpdateLater.Choice.TOMORROW, now)), picked)
    }

    @Test fun aRefusalIsSaidAndTheChangeVariantReadsChange() {
        compose.setContent { OrbitTheme {
            RunnerUpdateLaterButton("0.1.254", null, { "Runner is too old to update on request — it reports no self-update state" }, change = true, now = { now })
        } }
        compose.onNodeWithTag("runner-update-later").assertTextEquals("Change…").performClick()
        compose.waitForIdle()
        compose.onNodeWithTag("runner-update-later:hour").performClick()
        compose.waitForIdle()
        compose.onNode(hasText("Couldn’t postpone the update")).assertExists()
        compose.onNode(hasText("Runner is too old to update on request", substring = true)).assertExists()
    }

    private val gate = QueuedGate("runner_updating", 2, QueuedRunnerUpdate("0.1.254", now.minusSeconds(38 * 60L).toString(),
        listOf(QueuedRunnerUpdate.Turn("a1", "Backfill missing shard rows"))))

    @Test fun theQueuedPageAndTheFootRowsPopupOfferLater() {
        compose.setContent { OrbitTheme {
            RunnerUpdatingQueued(gate, "studio-mac", {}, now = now, later = { RunnerUpdateLaterButton("0.1.254", "studio-mac", { null }) })
        } }
        compose.onNodeWithTag("runner-update-later").assertTextEquals("Later…")
    }

    @Test fun theFootRowsPopupOffersLater() {
        compose.setContent { OrbitTheme {
            RunnerUpdatingFoot(gate, "studio-mac", now = now, later = { RunnerUpdateLaterButton("0.1.254", "studio-mac", { null }) })
        } }
        compose.onNodeWithTag("runner-updating-foot:reason", useUnmergedTree = true).performClick()
        compose.waitForIdle()
        compose.onNode(hasTestTag("runner-update-later") and hasAnyAncestor(isDialog())).assertTextEquals("Later…")
    }

    /** The runner page hands the card Later… while draining, Change… and Update Now… once postponed; SessionReader hands both views it. */
    @Test fun theRunnerPageAndTheReaderWireIt() {
        var dir: File? = File("").absoluteFile
        var screens = ""
        var reader = ""
        while (dir != null && (screens.isEmpty() || reader.isEmpty())) {
            File(dir, "app/src/main/kotlin/io/orbitd/android/management/RunnerScreens.kt").takeIf { it.isFile }?.let { screens = it.readText() }
            File(dir, "app/src/main/kotlin/io/orbitd/android/reader/SessionReader.kt").takeIf { it.isFile }?.let { reader = it.readText() }
            dir = dir.parentFile
        }
        assertTrue(screens.contains("if (card.phase == \"draining\" || card.phase == \"postponed\")"))
        assertTrue(screens.contains("}, change = card.phase == \"postponed\")"))
        assertTrue(screens.contains("confirmButton = { TextButton(onClick = { confirmingUpdateNow = false; updateRunner() })"))
        assertTrue(reader.contains("RunnerUpdatingFoot(it, runnerUpdatingMachine, later = runnerUpdatingLater)"))
        assertEquals(2, Regex("RunnerUpdatingQueued\\(runnerUpdatingPage, runnerUpdatingMachine, openTurn, later = runnerUpdatingLater\\)").findAll(reader).count())
        assertTrue(reader.contains("api.mutate(RunnerUpdateLater.path(runnerId), body = RunnerUpdateLater.body(until))"))
    }
}
