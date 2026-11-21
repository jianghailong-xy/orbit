package io.orbitd.android.cards

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
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
import io.orbitd.android.core.realtime.RunEvent
import io.orbitd.android.reader.SteerDelivery
import io.orbitd.android.reader.StickySummary
import io.orbitd.android.reader.TranscriptRowView
import io.orbitd.android.reader.transcriptRows
import io.orbitd.android.ui.OrbitTheme
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.time.Instant

/**
 * Owner rule (2026-11-16): the right side of a conversation is only for words the person typed. A turn Orbit opened whose note is a block
 * no client knows used to draw as a row headed with the reader's name and only "⊕ Orbit attached: context" in it; the known wakes (a
 * background job's news, a wakeup coming due, a watch's wake) sat inside a tinted "Orbit" row with a heading and Copy message. All of them
 * are heading-less lines between the assistant rows now, drawn by the production [TranscriptRowView] (web `Transcript.orbitEvent.test.tsx`,
 * OrbitKit `OrbitEventTests`). Typed words keep their row. Frames go to `src/android/build/evidence/orbit-event-line-android/`.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h891dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class OrbitEventLineTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    private val ago = Instant.now().minusSeconds(130).toString()
    private val future = "<orbit-future-thing>\n  Something the control plane will say one day.\n</orbit-future-thing>"
    private val job = "<background-job-wake>\n  A background job you started with bg_run has news you were waiting for; the control plane opened this turn for it:\n" +
        "    bgj_fixture｜job｜npm test｜web suite\n      ended｜completed｜exit code 0\n  The control plane recorded this for you; the user did not say it.\n</background-job-wake>"
    private val wakeup = "<scheduled-wakeup>\n  The wakeup you asked for with schedule_wakeup is due; the control plane opened this turn for it:\n" +
        "    2026-09-17T06:00:00.000Z scheduled 600 seconds out, due 2026-09-17T06:10:00.000Z\n    reason: watching CI run\n" +
        "    what you left for this turn:\n      read the CI result and fix what failed\n  The control plane recorded this for you; the user did not say it.\n</scheduled-wakeup>"
    private val subagent = "<orbit-subagent-finished>\n  SubAgent Find every caller of pollQuota (run 34y5Qcall0000000000001) finished: DONE\n  Result:\n" +
        "    Three callers, all in `quota/`: poller.ts, account.ts, limits.ts.\n  The control plane opened this turn for it.\n" +
        "  The control plane recorded this for you; the user did not say it. Whatever a SubAgent changed is in your working tree, uncommitted: " +
        "review it before you commit. To continue one, call delegate with resume set to its run id.\n</orbit-subagent-finished>"
    private val watch = "Orbit Watch 0199a8f0-1111-7aaa-8bbb-0000deadbeef matched at generation 2: ALL TASK_TERMINAL 1/1\n" +
        "This turn was queued by the watch, not typed by a person.\n```json\n" +
        "{\"watchId\":\"0199a8f0-1111-7aaa-8bbb-0000deadbeef\",\"changedTargets\":[{\"kind\":\"TASK\",\"id\":\"34task\",\"state\":\"SATISFIED\",\"observed\":{\"status\":\"DONE\"}}]}\n```"

    /** A `user` event as ingest stores it: the echo (typed words, then the note) and the note. */
    private fun turn(typed: String, note: String?) = RunEvent("user", 9, buildJsonObject {
        put("text", if (note == null) typed else typed + (if (typed.isEmpty()) "" else "\n\n") + note)
        note?.let { put("controlPlaneNote", it) }
    }, "turn-9", ago)

    private fun say(seq: Long, text: String) = RunEvent("assistant", seq, buildJsonObject { put("text", text) }, "turn-1", ago)

    private fun show(vararg middle: RunEvent) {
        val events = listOf(
            RunEvent("user", 1, buildJsonObject { put("text", "Fix the card and run the suite.") }, "turn-1", ago),
            say(2, "I'll start the suite in the background and keep going on the card.")) + middle +
            say(20, "The suite is green; the card fix is next.")
        val rows = transcriptRows(events)
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme {
            Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    rows.forEach { row -> TranscriptRowView(row, { error("no full read") }, null, {}) }
                }
            }
        } } }
        compose.waitForIdle()
    }

    /** A line in the agent's stream, not a third speaker: no heading, no Copy message, no "Orbit attached" on its row. */
    private fun assertHeadingless(tag: String) {
        listOf("Orbit", "You", "Copy message").forEach { word ->
            compose.onAllNodes(hasText(word) and hasAnyAncestor(hasTestTag(tag)), useUnmergedTree = true).assertCountEquals(0)
        }
        compose.onAllNodes(hasText("Orbit attached", substring = true) and hasAnyAncestor(hasTestTag(tag)), useUnmergedTree = true).assertCountEquals(0)
    }

    private fun text(words: String) =
        compose.onAllNodes(hasText(words) and hasAnyAncestor(hasTestTag("orbit-event")), useUnmergedTree = true).onFirst()

    @Test fun anUnknownBlockIsTheFromOrbitLineWithTheRawBlockUnderDetails() {
        val event = turn("", future)
        show(event)
        compose.onNodeWithTag("event:9").assert(hasAnyDescendant(hasTestTag("orbit-event")))
        // The mark is decorative (no semantics of its own), so it is found by its tag.
        compose.onAllNodesWithTag("orbit-event:mark", useUnmergedTree = true).onFirst().assertExists()
        text("From Orbit").assertExists()
        text("context").assertExists()
        text("2m ago").assertExists()
        text("Details").assertExists()
        assertHeadingless("event:9")
        compose.onAllNodes(hasText("<orbit-future-thing>", substring = true), useUnmergedTree = true).assertCountEquals(0)
        shot("01-from-orbit")
        compose.onNodeWithTag("orbit-event:line").performClick()
        compose.waitForIdle()
        text("What the agent read").assertExists()
        compose.onNodeWithTag("orbit-event:raw-text", useUnmergedTree = true).assertTextEquals(future)
        shot("02-from-orbit-details")
        // Not the reader's: no tray, no sticky anchor.
        assertFalse(SteerDelivery.readersOwn(event))
        assertFalse(StickySummary.isAnchor(event))
    }

    @Test fun knownBlocksKeepTheirLinesHeadinglessBetweenTheAssistantRows() {
        listOf(turn("", wakeup) to "background-wake",
            RunEvent("user", 9, buildJsonObject { put("text", watch) }, "turn-9", ago) to "watch-wake").forEachIndexed { i, (event, tag) ->
            show(event)
            assertTrue("$tag is drawn", compose.onAllNodes(hasTestTag(tag) and hasAnyAncestor(hasTestTag("event:9")), useUnmergedTree = true)
                .fetchSemanticsNodes().isNotEmpty())
            compose.onAllNodesWithTag("orbit-event", useUnmergedTree = true).assertCountEquals(0)
            assertHeadingless("event:9")
            shot("0${i + 4}-${listOf("wakeup", "watch")[i]}")
        }
    }

    // A job's end, new output or stall is drawn on its Job card (JobCardView, board C1), so its turn draws nothing at all: not a line, not
    // the From Orbit line, not the reader's row (web `Transcript.backgroundWake.test.tsx`).
    @Test fun aJobsNewsDrawsNothingWhichItsCardDraws() {
        val event = turn("", job)
        show(event)
        compose.onAllNodesWithTag("event:9", useUnmergedTree = true).assertCountEquals(0)
        compose.onAllNodesWithTag("background-wake", useUnmergedTree = true).assertCountEquals(0)
        compose.onAllNodesWithTag("orbit-event", useUnmergedTree = true).assertCountEquals(0)
        compose.onAllNodesWithText("From Orbit", useUnmergedTree = true).assertCountEquals(0)
        compose.onAllNodesWithText("web suite", substring = true, useUnmergedTree = true).assertCountEquals(0)
        assertFalse(SteerDelivery.readersOwn(event))
        assertFalse(SteerDelivery.orbitOnly(event))
    }

    // A SubAgent's end is drawn on its card (SubagentCardEnd), so its turn draws nothing at all: not a line of its own, not the From Orbit
    // line, not the reader's row (docs/mocks/subagent-card-and-end-line; web `Transcript.orbitEvent.test.tsx`).
    @Test fun aSubagentsEndDrawsNothingWhichItsCardDraws() {
        val event = turn("", subagent)
        show(event)
        compose.onAllNodesWithTag("event:9", useUnmergedTree = true).assertCountEquals(0)
        compose.onAllNodesWithTag("orbit-event", useUnmergedTree = true).assertCountEquals(0)
        compose.onAllNodesWithText("From Orbit", useUnmergedTree = true).assertCountEquals(0)
        compose.onAllNodesWithText("Fix the card and run the suite.", useUnmergedTree = true).assertCountEquals(1)
        compose.onAllNodesWithText("Find every caller of pollQuota", substring = true, useUnmergedTree = true).assertCountEquals(0)
        assertFalse(SteerDelivery.readersOwn(event))
        assertFalse(SteerDelivery.orbitOnly(event))
    }

    @Test fun typedWordsKeepTheirRowWithoutTheAppendedNote() {
        val event = turn("Ship it", future)
        show(event)
        compose.onAllNodesWithTag("orbit-event", useUnmergedTree = true).assertCountEquals(0)
        // The reader's own turn carries no heading (1da59c34c2, as iOS): only another sender's is headed.
        compose.onAllNodes(hasText("You") and hasAnyAncestor(hasTestTag("event:9")), useUnmergedTree = true).assertCountEquals(0)
        compose.onAllNodes(hasText("Ship it") and hasAnyAncestor(hasTestTag("event:9")), useUnmergedTree = true).assertCountEquals(1)
        compose.onAllNodes(hasText("Orbit attached", substring = true), useUnmergedTree = true).assertCountEquals(0)
        compose.onAllNodes(hasText("<orbit-future-thing>", substring = true), useUnmergedTree = true).assertCountEquals(0)
        assertTrue(SteerDelivery.readersOwn(event))
        assertTrue(StickySummary.isAnchor(event))
        shot("07-typed")
    }

    @Test fun aWakeCardKeepsItsContentWithoutTheLeftoverNoteOrFold() {
        val note = "$job\n\n$wakeup\n\n$future"
        show(turn("", note))
        compose.onNodeWithTag("background-wake", useUnmergedTree = true).assertExists()
        compose.onAllNodesWithText("Orbit attached", substring = true, useUnmergedTree = true).assertCountEquals(0)
        compose.onAllNodesWithText("<orbit-future-thing>", substring = true, useUnmergedTree = true).assertCountEquals(0)
    }

    private fun shot(name: String) {
        compose.waitForIdle()
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
            .first { File(it, "src/android/settings.gradle.kts").isFile }
        val output = File(root, "src/android/build/evidence/orbit-event-line-android").also { it.mkdirs() }
        val view = compose.activity.window.decorView
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }
}
