package io.orbitd.android.management

import android.content.ComponentName
import androidx.activity.ComponentActivity
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import io.orbitd.android.directory.QueuedGate
import io.orbitd.android.directory.QueuedRunnerUpdate
import io.orbitd.android.reader.RunnerUpdatingQueued
import io.orbitd.android.ui.OrbitTheme
import java.io.File
import java.time.Instant
import java.time.ZoneId
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * Update Now (docs/runner-update-drain-design.md D4; board 5's confirmation, board 4's Restarting and Updated cards): the words, by how
 * many turns it interrupts, the request, which runners offer it, the cards after it, and the transcript's two lines.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = io.orbitd.android.TestOrbitApplication::class)
class RunnerUpdateNowTest {
    @get:Rule(order = 0) val host = object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }
    @get:Rule(order = 1) val compose = createComposeRule()

    private val utc = ZoneId.of("UTC")
    private fun ms(iso: String) = Instant.parse(iso).toEpochMilli()

    private fun runner(selfUpdate: JsonObject, capabilities: List<String> = listOf(RunnerUpdateNow.CAPABILITY), turns: JsonArray? = null) = buildJsonObject {
        put("id", "0199a0c4-7a1e-7c3e-9d4f-2a6b8c0d1e31"); put("name", "studio-mac"); put("version", "0.1.253")
        putJsonArray("capabilities") { capabilities.forEach { add(it) } }
        put("selfUpdate", selfUpdate)
        turns?.let { put("updateTurns", it) }
    }
    private fun report(phase: String?, edit: JsonObjectBuilder.() -> Unit = {}) = buildJsonObject {
        phase?.let { put("phase", it) }
        put("targetVersion", "0.1.254")
        if (phase == "postponed") put("postponedUntil", "2023-11-15T02:00:00Z")
        edit()
    }

    @Test fun theConfirmationReadsByHowManyTurnsItStops() {
        assertEquals("Update studio-mac now?", RunnerUpdateNow.title("studio-mac"))
        assertEquals("No turn is running. It installs 0.1.254 and restarts — usually under a minute.", RunnerUpdateNow.message("0.1.254", 0))
        assertEquals("It stops this turn, installs 0.1.254 and restarts — usually under a minute. It then continues where it stopped, " +
            "with a note that the update interrupted it.", RunnerUpdateNow.message("0.1.254", 1))
        assertEquals("It stops these turns, installs 0.1.254 and restarts — usually under a minute. Each one then continues where it " +
            "stopped, with a note that the update interrupted it.", RunnerUpdateNow.message("0.1.254", 2))
        assertEquals("Update Now", RunnerUpdateNow.confirm(0))
        assertEquals("Interrupt 1 Turn and Update", RunnerUpdateNow.confirm(1))
        assertEquals("Interrupt 2 Turns and Update", RunnerUpdateNow.confirm(2))
        assertEquals("Background jobs in those sessions keep running; services they started are stopped. Waiting work starts once it is back.",
            RunnerUpdateNow.JOBS_NOTE)
        assertEquals("Couldn’t update the runner", RunnerUpdateNow.FAILED)
        assertEquals("Restarting into 0.1.254…", RunnerUpdateNow.toast("0.1.254"))
        assertEquals("Update Now…", RunnerUpdateNow.UPDATE_NOW)
    }

    /** The same words as the web's runnerCopy.ts, template for template. */
    @Test fun theWordsAreTheWebs() {
        var dir: File? = File("").absoluteFile
        var web: String? = null
        while (dir != null && web == null) {
            File(dir, "src/web/src/lib/runnerCopy.ts").takeIf { it.isFile }?.let { web = it.readText() }
            dir = dir.parentFile
        }
        val copy = web!!
        for (words in listOf(RunnerUpdateNow.title("\${runner}"), RunnerUpdateNow.message("\${version}", 0), RunnerUpdateNow.message("\${version}", 1),
            RunnerUpdateNow.message("\${version}", 2), RunnerUpdateNow.JOBS_NOTE, RunnerUpdateNow.confirm(0), RunnerUpdateNow.confirm(1),
            RunnerUpdateNow.FAILED, RunnerUpdateNow.toast("\${version}"), RunnerUpdateNow.UPDATE_NOW,
            RunnerCopy.updateUpdatedTitle("\${version}"), "1 interrupted turn continues once it is back. ", "1 interrupted turn resumed.")) {
            assertTrue("runnerCopy.ts does not say \"$words\"", copy.contains(words))
        }
        assertTrue(copy.contains("`Interrupt \${turns} Turns and Update`"))
        assertTrue(copy.contains("`\${turns} interrupted turns continue once it is back. Usually under a minute.`"))
        assertTrue(copy.contains("`\${turns} interrupted turns resumed.`"))
        // Android titles its interrupt rows (`Interrupted — the runner restarted`, as iOS does); the web's `⊘ interrupted — …` line says the same.
        assertTrue(copy.contains("`⊘ interrupted — the runner updated to \${version}`") && copy.contains("'⊘ interrupted — the runner updated'"))
    }

    @Test fun theRequestIsTheOwnersInterruptTheseTurns() {
        assertEquals(listOf("runners", "r1", "self-update", "now"), RunnerUpdateNow.path("r1"))
        assertEquals(buildJsonObject { put("interruptTurns", true) }, RunnerUpdateNow.request())
        assertEquals("""{"interruptTurns":true}""", RunnerUpdateNow.request().toString())
    }

    @Test fun onlyARunnerThatTakesItWithAReleaseWaitingOffersIt() {
        for (phase in listOf("available", "draining", "postponed")) assertTrue(phase, RunnerUpdateNow.offered(runner(report(phase))))
        assertFalse("restarting already", RunnerUpdateNow.offered(runner(report("restarting"))))
        assertFalse("no phase", RunnerUpdateNow.offered(runner(report(null))))
        assertFalse("too old", RunnerUpdateNow.offered(runner(report("draining"), capabilities = listOf("self-update-postpone/v1"))))
        assertFalse("no version", RunnerUpdateNow.offered(runner(buildJsonObject { put("phase", "draining") })))
        assertFalse("no report", RunnerUpdateNow.offered(buildJsonObject { putJsonArray("capabilities") { add(RunnerUpdateNow.CAPABILITY) } }))
    }

    @Test fun theTurnsAreTheRunnersWithHowLongEachHasRun() {
        val r = runner(report("available"), turns = buildJsonArray {
            addJsonObject { put("id", "a1"); put("title", "Backfill missing shard rows"); put("startedAt", "2023-11-14T21:59:20Z") }
            addJsonObject { put("id", "b2"); put("title", "Why are 11-08 metrics zero"); put("startedAt", "2023-11-14T23:13:20Z") }
            addJsonObject { put("id", "c3"); put("title", "  "); put("startedAt", "2023-11-14T21:51:20Z") }
        })
        assertEquals(listOf(
            RunnerPage.UpdateTurn("a1", "Backfill missing shard rows", "running 1 h 52 min"),
            RunnerPage.UpdateTurn("b2", "Why are 11-08 metrics zero", "running 38 min"),
            RunnerPage.UpdateTurn("c3", "Untitled session", "running 2 h"),
        ), RunnerPage.updateTurns(r, ms("2023-11-14T23:51:20Z")))
    }

    @Test fun restartingAfterUpdateNowCountsTheTurnsItInterrupted() {
        fun body(n: Int?) = RunnerPage.updateCard(runner(report("restarting") { n?.let { put("interruptedTurns", it) } }), ms("2023-11-15T00:00:00Z"), utc)!!.body
        assertEquals("Usually under a minute.", body(null))
        assertEquals("Usually under a minute.", body(0))
        assertEquals("1 interrupted turn continues once it is back. Usually under a minute.", body(1))
        assertEquals("2 interrupted turns continue once it is back. Usually under a minute.", body(2))
    }

    @Test fun theUpdatedCardSaysWhatTheLastUpdateTookForADay() {
        fun card(nowIso: String, edit: JsonObjectBuilder.() -> Unit) = RunnerPage.updateCard(runner(buildJsonObject {
            put("state", "enabled"); put("lastUpdatedAt", "2026-11-12T09:58:00Z"); put("lastUpdatedFrom", "0.1.253"); put("lastUpdatedTo", "0.1.254"); edit()
        }), ms(nowIso), utc)
        assertEquals(RunnerPage.UpdateCard("updated", false, "Updated to 0.1.254", "09:58", "Took 34 s. 2 interrupted turns resumed."),
            card("2026-11-12T11:00:00Z") { put("lastUpdateSeconds", 34); put("lastUpdateInterruptedTurns", 2) })
        assertEquals("Took 1 min 12 s. 1 interrupted turn resumed.",
            card("2026-11-12T11:00:00Z") { put("lastUpdateSeconds", 72); put("lastUpdateInterruptedTurns", 1) }!!.body)
        assertEquals("Took 2 min.", card("2026-11-12T11:00:00Z") { put("lastUpdateSeconds", 120); put("lastUpdateInterruptedTurns", 0) }!!.body)
        assertEquals("3 interrupted turns resumed.", card("2026-11-12T11:00:00Z") { put("lastUpdateInterruptedTurns", 3) }!!.body)
        assertEquals("", card("2026-11-12T11:00:00Z") { }!!.body)
        // A day on, About's Last Update says it; a report naming no version draws nothing.
        assertNotNull(card("2026-11-13T09:58:00Z") { })
        assertNull(card("2026-11-13T09:58:01Z") { })
        assertNull(RunnerPage.updateCard(runner(buildJsonObject { put("lastUpdatedAt", "2026-11-12T09:58:00Z") }), ms("2026-11-12T11:00:00Z"), utc))
        // A phase still says the phase.
        assertEquals("available", RunnerPage.updateCard(runner(report("available") { put("lastUpdatedAt", "2026-11-12T09:58:00Z"); put("lastUpdatedTo", "0.1.253") }),
            ms("2026-11-12T11:00:00Z"), utc)!!.phase)
        assertEquals(listOf("34 s", "59 s", "1 min", "1 min 12 s", "2 min"), listOf(34, 59, 60, 72, 120).map(RunnerCopy::updateTook))
    }

    @Test fun theTranscriptLines() {
        assertEquals("Interrupted — the runner updated to 0.1.254", RunnerUpdateNow.interruptedTitle("0.1.254"))
        assertEquals("Interrupted — the runner updated", RunnerUpdateNow.interruptedTitle(null))
        assertEquals("runner_update", RunnerUpdateNow.INTERRUPT_REASON)
        assertEquals("The runner update interrupted this turn; continue.", RunnerUpdateNow.RESUME_NOTE)
        assertTrue(RunnerUpdateNow.isResume("[Orbit] The runner update interrupted this turn; continue. Orbit updated its runner to 0.1.254 at 12:01."))
        assertTrue(RunnerUpdateNow.isResume("[Orbit] The runner update interrupted this turn; continue."))
        assertFalse(RunnerUpdateNow.isResume("The runner update interrupted this turn; continue."))
        assertFalse(RunnerUpdateNow.isResume("Why did [Orbit] The runner update interrupted this turn; continue. appear?"))
        assertFalse(RunnerUpdateNow.isResume(null))
    }

    private val turns = listOf(RunnerPage.UpdateTurn("a1", "Backfill missing shard rows", "running 1 h 52 min"),
        RunnerPage.UpdateTurn("b2", "Why are 11-08 metrics zero", "running 47 min"))

    @Test fun updateNowConfirmsWithTheTurnsAndAsks() {
        var asked = 0
        compose.setContent { OrbitTheme { RunnerUpdateNowButton("studio-mac", "0.1.254", { turns }, { asked++; null }) } }
        compose.onNodeWithTag("runner-update-now").assertTextEquals("Update Now…").performClick()
        compose.waitForIdle()
        compose.onNodeWithTag("runner-update-now-sheet:title", useUnmergedTree = true).assertTextEquals("Update studio-mac now?")
        compose.onNodeWithTag("runner-update-now-sheet:message", useUnmergedTree = true).assertTextEquals(RunnerUpdateNow.message("0.1.254", 2))
        compose.onNodeWithTag("runner-update-now-sheet:jobs", useUnmergedTree = true).assertTextEquals(RunnerUpdateNow.JOBS_NOTE)
        assertEquals(2, compose.onAllNodesWithTag("runner-update-now-turn", useUnmergedTree = true).fetchSemanticsNodes().size)
        compose.onNode(hasText("running 1 h 52 min")).assertExists()
        assertEquals(0, asked)
        compose.onNodeWithTag("runner-update-now:confirm").assertTextEquals("Interrupt 2 Turns and Update").performClick()
        compose.waitForIdle()
        assertEquals(1, asked)
    }

    @Test fun withNothingRunningItSaysSoAndARefusalIsSaid() {
        compose.setContent { OrbitTheme { RunnerUpdateNowButton("studio-mac", "0.1.254", { emptyList() }, { "Runner is offline" }) } }
        compose.onNodeWithTag("runner-update-now").performClick()
        compose.waitForIdle()
        compose.onNodeWithTag("runner-update-now-sheet:message", useUnmergedTree = true).assertTextEquals(RunnerUpdateNow.message("0.1.254", 0))
        assertTrue(compose.onAllNodesWithTag("runner-update-now-sheet:jobs", useUnmergedTree = true).fetchSemanticsNodes().isEmpty())
        compose.onNodeWithTag("runner-update-now:confirm").assertTextEquals("Update Now").performClick()
        compose.waitForIdle()
        compose.onNode(hasText("Couldn’t update the runner")).assertExists()
        compose.onNode(hasText("Runner is offline")).assertExists()
    }

    @Test fun theQueuedPageOffersLaterAndUpdateNow() {
        val now = Instant.parse("2026-11-12T12:00:00Z")
        val gate = QueuedGate("runner_updating", 2, QueuedRunnerUpdate("0.1.254", now.minusSeconds(38 * 60L).toString(),
            listOf(QueuedRunnerUpdate.Turn("a1", "Backfill missing shard rows"))))
        compose.setContent { OrbitTheme {
            RunnerUpdatingQueued(gate, "studio-mac", {}, now = now, later = {
                RunnerUpdateLaterButton("0.1.254", "studio-mac", { null })
                RunnerUpdateNowButton("studio-mac", "0.1.254", { turns }, { null })
            })
        } }
        compose.onNodeWithTag("runner-update-later").assertTextEquals("Later…")
        compose.onNodeWithTag("runner-update-now").assertTextEquals("Update Now…")
    }

    @Test fun anUpdatedCardWithNothingMeasuredHasNoBody() {
        compose.setContent { OrbitTheme { UpdateCardView(RunnerPage.UpdateCard("updated", false, "Updated to 0.1.254", "09:58", "")) } }
        compose.onNode(hasText("Updated to 0.1.254")).assertExists()
        compose.onNode(hasText("09:58")).assertExists()
        // The title and the tag: no empty body line under them.
        assertEquals(2, compose.onAllNodes(hasAnyAncestor(hasTestTag("runner-update-card")) and hasText("", substring = true), useUnmergedTree = true)
            .fetchSemanticsNodes().size)
    }

    /** The runner page offers it on a runner that takes it and keeps the older Update Now… for one that doesn't; the session page too. */
    @Test fun theRunnerPageAndTheReaderWireIt() {
        var dir: File? = File("").absoluteFile
        var screens = ""
        var reader = ""
        var rows = ""
        while (dir != null && (screens.isEmpty() || reader.isEmpty() || rows.isEmpty())) {
            File(dir, "app/src/main/kotlin/io/orbitd/android/management/RunnerScreens.kt").takeIf { it.isFile }?.let { screens = it.readText() }
            File(dir, "app/src/main/kotlin/io/orbitd/android/reader/SessionReader.kt").takeIf { it.isFile }?.let { reader = it.readText() }
            File(dir, "app/src/main/kotlin/io/orbitd/android/reader/TranscriptRowView.kt").takeIf { it.isFile }?.let { rows = it.readText() }
            dir = dir.parentFile
        }
        assertTrue(screens.contains("val updateNow = RunnerUpdateNow.offered(runner)"))
        assertTrue(screens.contains("model.press { api.post(RunnerUpdateNow.path(id).joinToString(\"/\"), RunnerUpdateNow.request()) }"))
        assertTrue(screens.contains("else if (card.phase == \"postponed\") OutlinedButton({ confirmingUpdateNow = true }"))
        assertTrue(reader.contains("runnerUpdatingRow?.takeIf(RunnerUpdateNow::offered)"))
        assertTrue(reader.contains("api.mutate(RunnerUpdateNow.path(runnerId), body = RunnerUpdateNow.request())"))
        assertTrue(rows.contains("RunnerUpdateNow.isResume(shown.fields.string(\"text\"))"))
        assertTrue(rows.contains("RunnerUpdateNow.INTERRUPT_REASON -> RunnerUpdateNow.interruptedTitle(event.fields.string(\"targetVersion\"))"))
    }
}
