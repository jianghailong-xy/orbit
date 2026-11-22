package io.orbitd.android.reader

import android.content.ComponentName
import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.unit.dp
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.realtime.RunEvent
import io.orbitd.android.ui.OrbitTheme
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
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * A background SubAgent is ONE card from start to end, as Claude Code's built-in Agent is (board docs/mocks/subagent-card-and-end-line,
 * approved 2026-11-20; web `Transcript.subagentEnd.test.tsx`, case for case). When its run ends, the card's row says how (✓ alone for
 * DONE; a word chip and the mark otherwise, grey for a stop), the line under the folded row becomes the ending, and the opened card closes
 * on its end. The turn the control plane opened for the end (`<orbit-subagent-finished>`) draws nothing: no line of its own, no From Orbit
 * line, no bubble. Drawn by the production [TranscriptRowView] over the web's own fixture blocks; frames go to
 * `src/android/build/evidence/subagent-card-end-android/`.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h891dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class SubagentCardEndTest {
    @get:Rule(order = 0) val host = object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }
    @get:Rule(order = 1) val compose = createAndroidComposeRule<ComponentActivity>()

    private val repo = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
        .first { File(it, "src/web/src/lib/subagentFinished.fixtures.ts").isFile }
    private val fixtures: Map<String, String> = Regex("export const (SUBAGENT_\\w+) =\\s*\\n\\s*(\"(?:[^\"\\\\]|\\\\.)*\");")
        .findAll(File(repo, "src/web/src/lib/subagentFinished.fixtures.ts").readText())
        .associate { it.groupValues[1] to (Json.parseToJsonElement(it.groupValues[2]) as JsonPrimitive).content }
    private val DONE get() = fixtures.getValue("SUBAGENT_DONE")
    private val FAILED get() = fixtures.getValue("SUBAGENT_FAILED")
    private val STOPPED get() = fixtures.getValue("SUBAGENT_STOPPED")
    private val INTERRUPTED get() = fixtures.getValue("SUBAGENT_INTERRUPTED")
    private val TWO get() = fixtures.getValue("SUBAGENT_TWO")
    private val STEER get() = fixtures.getValue("SUBAGENT_STEER")

    private data class Of(val runId: String, val status: String, val description: String)
    /** The runs the fixtures' blocks name, by the fixture. */
    private val runOf get() = mapOf(
        DONE to Of("34y5NxcqKYA179mC04VUB", "DONE", "Deploy 6bb50a957 to production"),
        FAILED to Of("34y5PfailRUNid0000001", "FAILED", "Write the poller spec"),
        STOPPED to Of("34y5PstopRUNid0000002", "STOPPED", "Sweep stale worktrees"),
        INTERRUPTED to Of("34y5PintrRUNid0000003", "INTERRUPTED", "Port the retry to the Go runner"),
    )

    private val files = listOf("src/apiserver/src/tasks/model-routing.ts", "src/apiserver/src/tasks/task-route-decision.ts",
        "src/web/src/components/TaskDetailPanel.modelRouting.test.tsx", "src/web/src/components/a.ts", "src/web/src/components/b.ts")

    /** The runner's own text for a run it lost: what used to restate the reason a second time. */
    private val orphaned = "The SubAgent was interrupted: the runner process hosting it stopped (a restart, an update or a crash) before " +
        "it reported an end. What it changed so far is in the working tree, uncommitted."

    private val ts = Instant.now().minusSeconds(30).toString()
    private val endedAt = Instant.now().minusSeconds(90).toString()

    private fun run(toolUseId: String, status: String, changed: List<String> = if (status == "DONE") emptyList() else files,
        resultSummary: String? = when (status) { "DONE" -> "Three callers, all in **quota/**."; "INTERRUPTED" -> orphaned; else -> null }) =
        SubagentRun(toolUseId, "general", true, status, "M", "claude-sonnet-5-5", "Sonnet 5.5", emptyList(), 0.0, resultSummary,
            Instant.now().minusSeconds(300).toString(), endedAt.takeIf { status != "RUNNING" }, why = "Tier M from the caller",
            changedFiles = changed)

    private fun ev(seq: Long, type: String, turn: String, build: JsonObjectBuilder.() -> Unit) = RunEvent(type, seq, buildJsonObject(build), turn, ts)

    /** A background delegate call, its launch receipt, and one step of its child. */
    private fun delegate(seq: Long, id: String, runId: String, description: String) = listOf(
        ev(seq, "tool_use", "turn-1") {
            put("id", id); put("name", SubagentBlock.TOOL_NAME)
            putJsonObject("input") { put("description", description); put("prompt", "Do it."); put("type", "general"); put("background", true) }
        },
        ev(seq + 1, "tool_result", "turn-1") { put("toolUseId", id); put("content", """{"runId":"$runId","status":"running"}""") },
        ev(seq + 2, "tool_use", "turn-1") {
            put("id", "$runId:c1"); put("name", "Edit"); put("parentToolUseId", id)
            putJsonObject("input") { put("file_path", "/repo/x.ts"); put("old_string", "a"); put("new_string", "b") }
        },
    )

    private val opening = ev(1, "user", "turn-1") { put("text", "Start them.") }

    /** A `user` event as ingest stores a wake turn: the echo, and the same block recorded as the note. */
    private fun wake(seq: Long, block: String, steer: Boolean = false) = ev(seq, "user", "turn-wake-$seq") {
        put("text", block); put("controlPlaneNote", block); if (steer) put("steer", true)
    }
    private fun reply(seq: Long, text: String, turn: String = "turn-wake-${seq - 1}") = ev(seq, "assistant", turn) { put("text", text) }

    private var queuedWakes by mutableStateOf<Map<String, (() -> Unit)?>>(emptyMap())

    private var shown by mutableStateOf<Pair<List<RunEvent>, List<SubagentRun>>>(emptyList<RunEvent>() to emptyList())
    private var started = false

    private fun mount(events: List<RunEvent>, runs: List<SubagentRun>) {
        compose.runOnIdle { shown = events to runs }
        if (!started) {
            started = true
            compose.setContent {
                val (evs, rs) = shown
                val rows = androidx.compose.runtime.remember(evs) { transcriptRows(evs) }
                OrbitTheme(darkTheme = false) {
                    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                        CompositionLocalProvider(LocalSubagentRuns provides rs.associateBy { it.toolUseId },
                            LocalSubagentWakes provides subagentWakesOf(evs), LocalSubagentQueuedWakes provides queuedWakes) {
                            Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                                rows.forEach { row -> androidx.compose.runtime.key(row.key) { TranscriptRowView(row, { error("no full read") }, null, {}) } }
                            }
                        }
                    }
                }
            }
        }
        compose.waitForIdle()
    }

    /** The one SubAgent of a block, its whole conversation and its run. */
    private fun oneRun(block: String, changed: List<String>? = null): Triple<List<RunEvent>, SubagentRun, String> {
        val of = runOf.getValue(block)
        val events = listOf(opening) + delegate(2, "toolu_bg", of.runId, of.description) + wake(9, block) + reply(10, "Carrying on.")
        return Triple(events, if (changed != null) run("toolu_bg", of.status, changed) else run("toolu_bg", of.status), of.runId)
    }

    private fun on(tag: String) = compose.onNode(hasTestTag(tag), useUnmergedTree = true)
    private fun all(tag: String) = compose.onAllNodes(hasTestTag(tag), useUnmergedTree = true)
    private fun textOf(tag: String) = on(tag).fetchSemanticsNode().config[androidx.compose.ui.semantics.SemanticsProperties.Text].joinToString("")
    private fun allText(words: String, substring: Boolean = true) = compose.onAllNodes(hasText(words, substring = substring), useUnmergedTree = true)
    private fun texts(within: String) = compose.onAllNodes(hasAnyAncestor(hasTestTag(within)), useUnmergedTree = true).fetchSemanticsNodes()
        .mapNotNull { it.config.getOrNull(androidx.compose.ui.semantics.SemanticsProperties.Text)?.joinToString("") }

    /** Every element that stands for a SubAgent: its cards, and any line or row drawn for its end turn. */
    private fun assertOneElementPerRun(cards: Int) {
        all("subagent-row").assertCountEquals(cards)
        all("event:9").assertCountEquals(0)
        all("orbit-event").assertCountEquals(0)
        all("background-wake").assertCountEquals(0)
        allText("SubAgent finished").assertCountEquals(0)
        allText("SubAgents finished").assertCountEquals(0)
        allText("From Orbit").assertCountEquals(0)
        allText("<orbit-subagent-finished>").assertCountEquals(0)
        // Only the words the reader typed are theirs.
        compose.onAllNodesWithText("Start them.", useUnmergedTree = true).assertCountEquals(1)
    }

    @Test fun runsAsOneCardWithItsLiveLine() {
        val of = runOf.getValue(DONE)
        mount(listOf(opening) + delegate(2, "toolu_bg", of.runId, of.description), listOf(run("toolu_bg", "RUNNING")))
        on("subagent-running").assertExists()
        assertEquals("Edit x.ts", textOf("subagent-live-line"))
        all("subagent-ending").assertCountEquals(0)
        all("subagent-end-chip").assertCountEquals(0)
        shot("01-running")
    }

    @Test fun endsDoneOnTheSameCardWithTwoLinesOfItsResultAndNothingWhereTheEndTurnOpened() {
        val (events, view) = oneRun(DONE)
        mount(events, listOf(view))
        assertOneElementPerRun(1)
        on("subagent-end-mark:done").assertExists()
        all("subagent-end-chip").assertCountEquals(0)
        all("subagent-live-line").assertCountEquals(0)
        assertEquals("Three callers, all in quota/.", textOf("subagent-ending"))
        allText("Carrying on.").assertCountEquals(1)
        shot("02-done")
    }

    @Test fun endsFailedInterruptedAndStoppedOnTheSameCardWithTheWordTheReasonOnceAndTheFiles() {
        for ((block, reason) in listOf(FAILED to "It did not finish its work.",
            INTERRUPTED to "The runner hosting it stopped (a restart, an update or a crash) before it finished.",
            STOPPED to "Stopped by the agent.")) {
            val (events, view) = oneRun(block)
            val word = view.status.lowercase()
            mount(events, listOf(view))
            assertOneElementPerRun(1)
            // The old bug: an interrupted or stopped run drew ✓ "Complete".
            all("subagent-end-mark:done").assertCountEquals(0)
            allText("Complete").assertCountEquals(0)
            on("subagent-end-mark:$word").assertExists()
            assertEquals(word, textOf("subagent-end-chip"))
            assertEquals(reason, textOf("subagent-ending-reason"))
            assertEquals(listOf("5 files left uncommitted", "Show files", "model-routing.ts · task-route-decision.ts · +3"),
                texts("subagent-ending-files"))
        }
    }

    @Test fun saysAnInterruptedRunsReasonOnceFoldedAndOpenedNeverTheRunnersRestatement() {
        val (events, view, runId) = oneRun(INTERRUPTED, changed = List(9) { "src/f$it.ts" })
        mount(events, listOf(view))
        assertEquals(listOf("9 files left uncommitted", "Show files", "f0.ts · f1.ts · +7"), texts("subagent-ending-files"))
        allText("before it finished").assertCountEquals(1)
        allText("The SubAgent was interrupted").assertCountEquals(0)
        shot("03-interrupted-folded")

        // Show files opens the card on its end block.
        on("subagent-show-files").performClick()
        compose.waitForIdle()
        on("subagent-end:failed").assertExists()
        all("subagent-ending").assertCountEquals(0)
        assertTrue(textOf("subagent-end-head"),
            Regex("^Interrupted \\dm ago: the runner hosting it stopped \\(a restart, an update or a crash\\) before it finished\\.$")
                .matches(textOf("subagent-end-head")))
        allText("The SubAgent was interrupted").assertCountEquals(0)
        allText("before it finished").assertCountEquals(1)
        assertEquals("9 files left uncommitted in the working tree:", textOf("subagent-end-files-head"))
        assertEquals(listOf("src/f0.ts", "src/f1.ts", "src/f2.ts", "… 6 more"), texts("subagent-end-files"))
        shot("04-interrupted-opened")
        on("subagent-end-more").performClick()
        compose.waitForIdle()
        assertEquals(9, texts("subagent-end-files").size)

        all("subagent-end-raw-text").assertCountEquals(0)
        compose.onAllNodes(hasText("What the agent read") and hasAnyAncestor(hasTestTag("subagent-end-raw")), useUnmergedTree = true)
            .assertCountEquals(1)
        on("subagent-end-raw").performClick()
        compose.waitForIdle()
        assertEquals(INTERRUPTED, textOf("subagent-end-raw-text"))
        val at = DateTimeFormatter.ofPattern("HH:mm").withZone(ZoneId.systemDefault()).format(Instant.parse(ts))
        assertEquals("Run $runId · read by the agent at $at", textOf("subagent-end-run"))
    }

    @Test fun greysAStoppedRunsEndAsNoFailure() {
        val (events, view) = oneRun(STOPPED)
        mount(events, listOf(view))
        // Grey, read off the drawn pixels: the chip and the reason hold the theme's onSurfaceVariant and never its error red.
        val pixels = pixelsOf("subagent-end-chip") + pixelsOf("subagent-ending-reason")
        assertTrue("grey is drawn", GREY in pixels)
        assertFalse("no red is drawn", RED in pixels)
        shot("05-stopped")
        on("subagent-row").performClick()
        compose.waitForIdle()
        on("subagent-end:stopped").assertExists()
        all("subagent-end:failed").assertCountEquals(0)
        assertTrue(textOf("subagent-end-head"), Regex("^Stopped \\dm ago by the agent\\.$").matches(textOf("subagent-end-head")))
        assertFalse(RED in pixelsOf("subagent-end-head"))
        shot("06-stopped-opened")

        // An interrupted run's chip, by contrast, is red.
        val (failedEvents, failedView) = oneRun(INTERRUPTED)
        mount(failedEvents, listOf(failedView))
        assertTrue(RED in pixelsOf("subagent-end-chip"))
    }

    @Test fun updatesEachCardOfAWakeThatNamesTwoRunsAndDrawsNothingAtTheWake() {
        val events = listOf(opening) + delegate(2, "toolu_a", "34y5Qcall0000000000001", "Find every caller of pollQuota") +
            delegate(5, "toolu_b", "34y5Qspec0000000000002", "Write the poller spec") + wake(9, TWO) + reply(10, "One of two came back.")
        mount(events, listOf(run("toolu_a", "DONE"), run("toolu_b", "FAILED")))
        assertOneElementPerRun(2)
        compose.onNode(hasTestTag("subagent-end-mark:done") and hasAnyAncestor(hasTestTag("event:2")), useUnmergedTree = true).assertExists()
        compose.onNode(hasTestTag("subagent-end-chip") and hasAnyAncestor(hasTestTag("event:5")), useUnmergedTree = true).assertTextEquals("failed")
        compose.onNode(hasTestTag("subagent-row") and hasAnyAncestor(hasTestTag("event:2")), useUnmergedTree = true).performClick()
        compose.waitForIdle()
        on("subagent-end-raw").performClick()
        compose.waitForIdle()
        assertEquals(TWO, textOf("subagent-end-raw-text"))
    }

    @Test fun drawsNothingForAWakeWrittenIntoTheRunningTurn() {
        val events = listOf(opening) + delegate(2, "toolu_bg", "34y5Qcall0000000000001", "Find every caller of pollQuota") +
            wake(9, STEER, steer = true) + reply(10, "Noted, carrying on.", "turn-1")
        mount(events, listOf(run("toolu_bg", "DONE")))
        assertOneElementPerRun(1)
        allText("It ended while you were working").assertCountEquals(0)
        allText("Read in this turn").assertCountEquals(0)
        allText("Sending…").assertCountEquals(0)
    }

    @Test fun keepsAWakeupWrittenBesideTheEndAsItsOwnLineAndOnlyThat() {
        val job = listOf("<background-job-wake>",
            "  A background job you started with bg_run has news you were waiting for; the control plane opened this turn for it:",
            "    bgj_13c53745a88a｜job｜make test｜unit tests", "      ended｜completed｜exit code 0",
            "      output /root/.orbit/runs/4f50733a/bgj_13c53745a88a.output｜this covers bytes 0–10", "      (no output)",
            "  The control plane recorded this for you; the user did not say it.", "</background-job-wake>").joinToString("\n")
        val wakeup = listOf("<scheduled-wakeup>",
            "  The wakeup you asked for with schedule_wakeup is due; the control plane opened this turn for it:",
            "    2026-09-17T06:00:00.000Z scheduled 600 seconds out, due 2026-09-17T06:10:00.000Z", "    reason: watching CI run",
            "  The control plane recorded this for you; the user did not say it.", "</scheduled-wakeup>").joinToString("\n")
        val (events, view) = oneRun(DONE)
        // A job's news beside the end draws nothing either: its Job card says it (board C1).
        mount(events.map { if (it.seq == 9L) wake(9, "$DONE\n\n$job") else it }, listOf(view))
        all("background-wake").assertCountEquals(0)
        all("subagent-row").assertCountEquals(1)
        mount(events.map { if (it.seq == 9L) wake(9, "$DONE\n\n$job\n\n$wakeup") else it }, listOf(view))
        all("background-wake").assertCountEquals(1)
        all("subagent-row").assertCountEquals(1)
        allText("SubAgent finished").assertCountEquals(0)
    }

    @Test fun drawsTheFromOrbitLineForABlockInAWordingItDoesNotKnow() {
        val (events, view) = oneRun(DONE)
        val odd = DONE.replace("finished: DONE", "finished: LOST")
        mount(events.map { if (it.seq == 9L) wake(9, odd) else it }, listOf(view))
        all("orbit-event").assertCountEquals(1)
        compose.onAllNodes(hasText("finished: LOST", substring = true) and hasAnyAncestor(hasTestTag("event:9")) and
            hasAnyAncestor(hasTestTag("orbit-event")).not(), useUnmergedTree = true).assertCountEquals(0)
    }

    @Test fun aQueuedEndSaysSoOnTheCardWithDontSendAndTheLineIsGoneOnceDelivered() {
        val (events, view, runId) = oneRun(DONE)
        val undelivered = events.filter { it.seq < 9 }
        var sent = 0
        queuedWakes = mapOf(runId to { sent++ })
        mount(undelivered, listOf(view))
        assertEquals(listOf("Waiting for the agent to read it ·", "Don't send"), texts("subagent-queued"))
        all("subagent-row").assertCountEquals(1)
        shot("07-queued")
        on("subagent-dont-send").performClick()
        compose.waitForIdle()
        assertEquals(1, sent)
        // The card itself still opens: the line is under it, not in its way.
        on("subagent-row").performClick()
        compose.waitForIdle()
        on("subagent-end:ok").assertExists()

        queuedWakes = emptyMap()
        mount(events, listOf(view))
        all("subagent-queued").assertCountEquals(0)
        assertOneElementPerRun(1)
    }

    @Test fun theQueuedTailLeavesASubagentsEndAndAJobsNewsToTheirCards() {
        fun listed(id: String, content: String, kind: String = "message") = buildJsonObject {
            put("turnId", id); put("content", content); put("kind", kind); put("authoredByOrbit", true) }
        val job = "<background-job-wake>\n  A background job you started with bg_run has news you were waiting for; the control plane opened this turn for it:\n" +
            "    bgj_13c53745a88a｜job｜make test｜unit tests\n      ended｜completed｜exit code 0\n" +
            "      output /root/.orbit/runs/4f50733a/bgj_13c53745a88a.output｜this covers bytes 0–10\n      (no output)\n" +
            "  The control plane recorded this for you; the user did not say it.\n</background-job-wake>"
        val tail = queuedTail(listOf(listed("turn-two", TWO), listed("turn-job", "$DONE\n\n$job"), listed("turn-steer", STEER, "steer")), emptyList())
        // A job's news beside the end waits on its Job card too (board E1): the tail draws neither.
        assertEquals(listOf(false, false, false), tail.map { it.inTail() })
        assertEquals(listOf("bgj_13c53745a88a"), tail[1].jobIds)
        assertTrue(tail.none { it.readersOwn || it.inTray })
        val cancelled = mutableListOf<String>()
        val wakes = subagentQueuedWakes(tail, cancelEnabled = true) { cancelled += it }
        assertEquals(setOf("34y5Qcall0000000000001", "34y5Qspec0000000000002", "34y5NxcqKYA179mC04VUB"), wakes.keys)
        wakes.getValue("34y5Qspec0000000000002")!!.invoke()
        assertEquals(listOf("turn-two"), cancelled)
        // A steer already on its way into the running turn cannot be taken back: its line says it waits, with no Don't send.
        assertNull(subagentQueuedWakes(tail.filter { it.steer }, cancelEnabled = true) { }.getValue("34y5Qcall0000000000001"))
        assertTrue(subagentQueuedWakes(tail, cancelEnabled = false) { }.values.all { it == null })
    }

    @Test fun theEndsWordsAreTheWebs() {
        val now = Instant.parse("2026-11-15T16:40:00Z")
        val ended = run("t", "INTERRUPTED").copy(endedAt = "2026-11-15T16:30:00Z")
        assertEquals("Interrupted 10m ago: the runner hosting it stopped (a restart, an update or a crash) before it finished.",
            SubagentEnd.head(ended, now))
        assertEquals("Failed 10m ago: it did not finish its work.", SubagentEnd.head(ended.copy(status = "FAILED"), now))
        assertEquals("Stopped 10m ago by the agent.", SubagentEnd.head(ended.copy(status = "STOPPED"), now))
        assertNull(SubagentEnd.head(ended.copy(status = "DONE"), now))
        assertEquals("1 file left uncommitted", SubagentEnd.fileCount(1))
        assertEquals("a.ts", SubagentEnd.names(listOf("src/a.ts")))
        assertEquals(SubagentEnd.Tone.STOPPED, SubagentEnd.tone("STOPPED"))
        assertEquals(SubagentEnd.Tone.FAILED, SubagentEnd.tone("INTERRUPTED"))
        assertNull("a foreground call is its own end", SubagentEnd.ended(run("t", "DONE").copy(background = false)))
        assertNull(SubagentEnd.ended(run("t", "RUNNING")))
        assertEquals(listOf("a.ts", "b.ts"), SubagentRun.from(buildJsonObject {
            put("toolUseId", "t"); put("status", "DONE"); putJsonArray("changedFiles") { add("a.ts"); add("b.ts") } })!!.changedFiles)
    }

    // Light theme (ui/OrbitTheme.kt): onSurfaceVariant and error.
    private val GREY = 0xFF555861.toInt()
    private val RED = 0xFFB3261E.toInt()

    private fun frame(): Bitmap {
        compose.waitForIdle()
        val decor = compose.activity.window.decorView
        return Bitmap.createBitmap(decor.width, decor.height, Bitmap.Config.ARGB_8888).also { decor.draw(Canvas(it)) }
    }

    private fun pixelsOf(tag: String): Set<Int> {
        val bounds = on(tag).fetchSemanticsNode().boundsInWindow
        val bitmap = frame()
        val x = bounds.left.toInt().coerceAtLeast(0); val y = bounds.top.toInt().coerceAtLeast(0)
        val w = (bounds.right.toInt() - x).coerceAtMost(bitmap.width - x); val h = (bounds.bottom.toInt() - y).coerceAtMost(bitmap.height - y)
        val out = IntArray(w * h).also { bitmap.getPixels(it, 0, w, x, y, w, h) }
        bitmap.recycle()
        return out.toSet()
    }

    private fun shot(name: String) {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }.first { File(it, "src/android").isDirectory }
        val output = File(root, "src/android/build/evidence/subagent-card-end-android").also { it.mkdirs() }
        val bitmap = frame()
        File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }
}
