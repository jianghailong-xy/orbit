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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.cards.BgJob
import io.orbitd.android.core.net.ApiError
import io.orbitd.android.core.realtime.RunEvent
import io.orbitd.android.ui.OrbitTheme
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
import org.robolectric.annotation.GraphicsMode
import java.io.File
import java.time.Instant

/**
 * A bg_run job is ONE card from start to end (the owner's job-card board, file 350t1lTONlrPMjilBdXx7, A1 B1 C1 D1 E1 F1 and rulings R1-R4
 * of 2026-11-21; web `Transcript.jobCard.test.tsx`, case for case). Drawn by the production [TranscriptRowView] over a bg_run call and its
 * receipt: each folded state, the opened card, the tail read while it runs, Stop behind its confirmation, the wake turn drawing nothing,
 * the queued wake waiting on the card, and the header at phone and desktop width. Frames go to `src/android/build/evidence/job-card-android/`.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h891dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class JobCardTest {
    @get:Rule(order = 0) val host = object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }
    @get:Rule(order = 1) val compose = createAndroidComposeRule<ComponentActivity>()

    @Before fun manualClock() { compose.mainClock.autoAdvance = false }

    private val startedAt = Instant.now().minusSeconds(760).toString()
    private val endedAt = Instant.now().toString()

    private fun ev(seq: Long, type: String, build: JsonObjectBuilder.() -> Unit) = RunEvent(type, seq, buildJsonObject(build), "turn-1", startedAt)

    /** A bg_run call and the running receipt it answered with, at [seq] and [seq]+1. */
    private fun call(seq: Long, jobId: String, description: String = "Wait for CI JavaScript job on 4c8f5a8a1b", kind: String = "watch",
        command: String = "gh run watch 19632123456 --exit-status --interval 30") = listOf(
        ev(seq, "tool_use") {
            put("id", "toolu_$jobId"); put("name", BgJob.TOOL)
            putJsonObject("input") { put("command", command); put("description", description); put("kind", kind); put("wakeOnExit", true) }
        },
        ev(seq + 1, "tool_result") {
            put("toolUseId", "toolu_$jobId")
            put("content", """{"receiptVersion":1,"ok":true,"entity":{"jobId":"$jobId","status":"running","startedAt":"$startedAt"}}""")
        },
    )

    /** The runner's launch pair for the same job: a Bash call with run_in_background, under the job's own id. */
    private fun launchPair(seq: Long, jobId: String) = listOf(
        ev(seq, "tool_use") { put("id", jobId); put("name", "Bash"); putJsonObject("input") { put("command", "gh run watch"); put("run_in_background", true) } },
        ev(seq + 1, "tool_result") { put("toolUseId", jobId); put("content", "Command running in background with ID: $jobId.") },
    )

    private fun wakeBlock(jobId: String, trigger: String, tail: String?) =
        "<background-job-wake>\n  A background job you started with bg_run has news you were waiting for; the control plane opened this turn for it:\n" +
            "    $jobId｜watch｜gh run watch 19632123456 --exit-status --interval 30｜Wait for CI JavaScript job on 4c8f5a8a1b\n      $trigger\n" +
            "      output /root/.orbit/runs/x/$jobId.output｜this covers bytes 0–400\n" +
            (if (tail != null) "      output tail:\n" + tail.lines().joinToString("\n") { "        $it" } + "\n" else "      (no output)\n") +
            "  The control plane recorded this for you; the user did not say it.\n</background-job-wake>"
    private fun stallBlock(jobId: String) = listOf("<background-job-stall>",
        "  A background job you started with bg_run is still running and has written nothing for as long as you asked to be told about; the control plane opened this turn for it:",
        "    $jobId｜job｜./deploy.sh 5dd308afd｜Deploy 5dd308afd",
        "      gone quiet｜still running｜running for 22m 0s when this was sent",
        "      no new output for 10m 0s｜last output at 2026-11-21T10:20:00Z",
        "      output /root/.orbit/runs/x/$jobId.output｜this covers bytes 0–21",
        "      output tail:", "        Waiting for apiserver-next to pass its health check…",
        "  The control plane recorded this for you; the user did not say it.", "</background-job-stall>").joinToString("\n")
    private val wakeup = "<scheduled-wakeup>\n  The wakeup you asked for with schedule_wakeup is due; the control plane opened this turn for it:\n" +
        "    2026-11-21T10:00:00.000Z scheduled 600 seconds out, due 2026-11-21T10:10:00.000Z\n    reason: check the deploy\n" +
        "  The control plane recorded this for you; the user did not say it.\n</scheduled-wakeup>"
    private fun wakeTurn(seq: Long, note: String) = RunEvent("user", seq, buildJsonObject { put("text", note); put("controlPlaneNote", note) },
        "turn-wake-$seq", endedAt)

    private fun shell(jobId: String, vararg fields: Pair<String, Any>) = buildJsonObject {
        put("shellId", jobId); put("kind", "job"); put("toolUseId", jobId); put("command", "gh run watch"); put("startedTs", startedAt)
        fields.forEach { (k, v) -> when (v) { is String -> put(k, v); is Int -> put(k, v); is Boolean -> put(k, v) } }
    }
    private fun tailOf(status: String, vararg lines: String, exitCode: Int? = null) = buildJsonObject {
        put("status", status); put("exitCode", exitCode?.let(::JsonPrimitive) ?: JsonNull); putJsonArray("lines") { lines.forEach { add(it) } }
    }

    private var shown by mutableStateOf(emptyList<RunEvent>() to JobCards())
    private var started = false

    private fun mount(events: List<RunEvent>, jobs: JobCards) {
        compose.runOnIdle { shown = events to jobs }
        if (!started) {
            started = true
            compose.setContent {
                val (evs, js) = shown
                val rows = androidx.compose.runtime.remember(evs) { transcriptRows(evs) }
                OrbitTheme(darkTheme = false) {
                    Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                        CompositionLocalProvider(LocalJobCards provides js.copy(wakes = js.wakes.ifEmpty { JobCards.wakes(evs) })) {
                            Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(vertical = 8.dp),
                                verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                rows.forEach { row -> androidx.compose.runtime.key(row.key) { TranscriptRowView(row, { error("no full read") }, null, {}) } }
                            }
                        }
                    }
                }
            }
        }
        settle()
    }

    private fun settle() { compose.waitForIdle(); compose.mainClock.advanceTimeByFrame(); compose.waitForIdle() }
    private fun frames(ms: Long) { compose.mainClock.advanceTimeBy(ms); settle() }
    private fun on(tag: String) = compose.onNode(hasTestTag(tag), useUnmergedTree = true)
    private fun all(tag: String) = compose.onAllNodes(hasTestTag(tag), useUnmergedTree = true)
    private fun within(card: String, tag: String) = compose.onNode(hasTestTag(tag) and hasAnyAncestor(hasTestTag(card)), useUnmergedTree = true)
    /** The colour a Text node was laid out in. */
    private fun colorOf(node: SemanticsNodeInteraction): androidx.compose.ui.graphics.Color {
        val results = mutableListOf<androidx.compose.ui.text.TextLayoutResult>()
        node.fetchSemanticsNode().config[androidx.compose.ui.semantics.SemanticsActions.GetTextLayoutResult].action!!.invoke(results)
        return results.first().layoutInput.style.color
    }
    private fun textOf(node: SemanticsNodeInteraction) = node.fetchSemanticsNode().config.getOrNull(SemanticsProperties.Text)?.joinToString("").orEmpty()
    private fun texts(within: String) = compose.onAllNodes(hasAnyAncestor(hasTestTag(within)), useUnmergedTree = true).fetchSemanticsNodes()
        .mapNotNull { it.config.getOrNull(SemanticsProperties.Text)?.joinToString("") }

    // MARK: the card in place of the call (A1, R4)

    @Test fun aBgRunCallIsOneCardAndItsLaunchPairDrawsNothing() {
        mount(call(2, "bgj_a1") + launchPair(4, "bgj_a1"), JobCards(live = true))
        all("job-row").assertCountEquals(1)
        on("job-icon").assertExists()
        assertEquals("Wait for CI JavaScript job on 4c8f5a8a1b", textOf(on("job-title")))
        assertEquals("watch", textOf(on("job-kind")))
        // The generic call card and the runner's Bash pair are gone; the header never carries the word Job (R4).
        compose.onAllNodesWithText("mcp__orbit__bg_run", substring = true, useUnmergedTree = true).assertCountEquals(0)
        compose.onAllNodesWithText("Bash", useUnmergedTree = true).assertCountEquals(0)
        compose.onAllNodesWithText("Job", useUnmergedTree = true).assertCountEquals(0)
        assertFalse(texts("job-card:bgj_a1").any { Regex("\\bJob\\b").containsMatchIn(it) })
    }

    @Test fun atPhoneWidthTheKindAndRunTimeMoveToASecondGreyLine() {
        mount(call(2, "bgj_a1"), JobCards(live = true))
        within("job-sub", "job-kind").assertExists()
        within("job-sub", "job-elapsed").assertExists()
        // The kind wears the accent tint (web `.chat-tool-tag`, teal on light teal); the run time beside it stays grey.
        assertEquals(ExecTone, colorOf(on("job-kind")))
        assertEquals(androidx.compose.ui.graphics.Color(0xFF555861), colorOf(on("job-elapsed")))
        compose.onAllNodes(hasTestTag("job-kind") and hasAnyAncestor(hasTestTag("job-row")), useUnmergedTree = true).assertCountEquals(0)
        assertTrue(textOf(on("job-elapsed")), Regex("^1[23]m \\d\\ds$").matches(textOf(on("job-elapsed"))))
        shot("10-header-phone")
    }

    @Config(qualifiers = "w900dp-h891dp-xhdpi")
    @Test fun onAWideScreenTheHeaderIsOneLine() {
        mount(call(2, "bgj_a1"), JobCards(live = true))
        all("job-sub").assertCountEquals(0)
        within("job-row", "job-kind").assertExists()
        within("job-row", "job-elapsed").assertExists()
        assertEquals(ExecTone, colorOf(on("job-kind")))
        shot("11-header-wide")
    }

    // MARK: each folded state

    @Test fun runningItSpinsAndShowsItsNewestLineReadFromTheTailWhileOnScreen() {
        var reads = 0
        var answer = tailOf("running", "✓ src/components/Transcript.test.tsx (412 tests) 9.8s", "✓ src/lib/bgJobCard.test.ts (50 tests) 0.4s")
        mount(call(2, "bgj_a1", "Full web test suite", "job"), JobCards(live = true, tail = { id -> assertEquals("bgj_a1", id); reads++; answer }))
        assertEquals(1, reads)
        on("job-mark:running").assertExists()
        assertEquals("✓ src/lib/bgJobCard.test.ts (50 tests) 0.4s", textOf(on("job-live-line")))
        shot("01-running")
        // At the route's pace: 5 s after each answer, one at a time.
        frames(4_000); assertEquals(1, reads)
        answer = tailOf("running", "✓ src/components/JobCard.test.tsx (30 tests) 1.1s")
        frames(1_500); assertEquals(2, reads)
        assertEquals("✓ src/components/JobCard.test.tsx (30 tests) 1.1s", textOf(on("job-live-line")))
        // It ends: the read says so, and nothing reads again.
        answer = tailOf("completed", "Test Files  641 passed (641)", "     Tests  8723 passed (8723)", exitCode = 0)
        frames(5_500); assertEquals(3, reads)
        on("job-mark:done").assertExists()
        frames(30_000); assertEquals(3, reads)
    }

    @Test fun theTailIsReadOnlyWhileTheCardIsOnScreen() {
        var reads = 0
        val read: suspend (String) -> JsonObject = { reads++; tailOf("running", "line $reads") }
        mount(call(2, "bgj_a1"), JobCards(live = true, tail = read))
        assertEquals(1, reads)
        // The card leaves the screen (its row is no longer composed): no more reads.
        mount(emptyList(), JobCards(live = true, tail = read))
        frames(20_000)
        assertEquals(1, reads)
        mount(call(2, "bgj_a1"), JobCards(live = true, tail = read))
        assertEquals(2, reads)
    }

    @Test fun aRunnerTooOldToReadTheTailShowsNoLineAndKeepsSpinning() {
        var reads = 0
        mount(call(2, "bgj_a1"), JobCards(live = true, tail = { reads++; throw ApiError.parse(409, """{"code":"RUNNER_CANNOT_READ_JOB_OUTPUT"}""".encodeToByteArray()) }))
        frames(60_000)
        assertEquals(1, reads)
        on("job-mark:running").assertExists()
        all("job-live-line").assertCountEquals(0)
        compose.onAllNodesWithText("RUNNER_CANNOT_READ_JOB_OUTPUT", substring = true, useUnmergedTree = true).assertCountEquals(0)
    }

    @Test fun exitZeroIsACheckAndItsLastTwoLinesGrey() {
        mount(call(2, "bgj_a1", "Full web test suite", "job") + wakeTurn(9, wakeBlock("bgj_a1", "ended｜completed｜exit code 0",
            "RUN v3\nTest Files  641 passed (641)\n     Tests  8723 passed (8723)")),
            JobCards(shells = mapOf("bgj_a1" to shell("bgj_a1", "status" to "done", "terminal" to "done", "exitCode" to 0, "endedAt" to endedAt))))
        on("job-mark:done").assertExists()
        all("job-exit").assertCountEquals(0)
        assertEquals(listOf("Test Files  641 passed (641)", "     Tests  8723 passed (8723)"), texts("job-tail"))
        on("job-show-full").assertTextEquals("Show full output")
        shot("02-exit-0")
    }

    @Test fun exitNIsARedChipACrossAndItsLastTwoLines() {
        mount(call(2, "bgj_a1", "Build apiserver image", "job") + wakeTurn(9, wakeBlock("bgj_a1", "ended｜failed｜exit code 1",
            "Step 4/9 : RUN npm ci\nnpm error network ECONNRESET\nERROR: process \"/bin/sh -c npm ci\" did not complete: exit code 1")),
            JobCards(live = true))
        on("job-exit").assertTextEquals("exit 1")
        on("job-mark:failed").assertExists()
        compose.onAllNodes(hasAnyAncestor(hasTestTag("job-tail")), useUnmergedTree = true).fetchSemanticsNodes().indices.forEach { i ->
            assertEquals(androidx.compose.ui.graphics.Color(0xFFB3261E), colorOf(compose.onAllNodes(hasAnyAncestor(hasTestTag("job-tail")), useUnmergedTree = true)[i]))
        }
        assertEquals(listOf("npm error network ECONNRESET", "ERROR: process \"/bin/sh -c npm ci\" did not complete: exit code 1"), texts("job-tail"))
        shot("03-exit-n")
        on("job-show-full").performClick(); settle()
        on("job-detail").assertExists()
    }

    @Test fun killedIsGreyAndNamesWhoStoppedIt() {
        listOf("stopped_by_owner", "requested", "runner_shutdown", "session_cancelled").forEachIndexed { i, reason ->
            mount(call(2, "bgj_a1", "Android unit tests", "job"), JobCards(live = true,
                shells = mapOf("bgj_a1" to shell("bgj_a1", "status" to "killed", "terminal" to "killed", "reason" to reason, "endedAt" to endedAt))))
            on("job-killed").assertTextEquals("killed")
            on("job-mark:killed").assertExists()
            all("job-exit").assertCountEquals(0)
            on("job-killed-by").assertTextEquals(BgJob.killedBy(reason)!!)
            if (i == 0) shot("04-killed")
        }
        assertEquals("The person who owns this session stopped it from the app.", BgJob.killedBy("stopped_by_owner"))
    }

    @Test fun quietIsAnAmberChipWhileItStillSpins() {
        mount(call(2, "bgj_q1", "Deploy 5dd308afd", "job") + wakeTurn(9, stallBlock("bgj_q1")), JobCards(live = true))
        on("job-quiet").assertTextEquals("quiet 10m")
        on("job-mark:running").assertExists()
        assertEquals("Waiting for apiserver-next to pass its health check…", textOf(on("job-live-line")))
        all("background-wake").assertCountEquals(0)
        shot("05-quiet")
    }

    @Test fun aServiceNeverEndsAndKeepsSpinning() {
        mount(call(2, "bgj_s1", "npm run dev", "service", "npm run dev"), JobCards(live = true,
            tail = { tailOf("running", "  ➜  Local:   http://localhost:5173/") }))
        on("job-kind").assertTextEquals("service")
        on("job-mark:running").assertExists()
        assertEquals("  ➜  Local:   http://localhost:5173/", textOf(on("job-live-line")))
        shot("06-service")
    }

    @Test fun newOutputRefreshesTheTailWithNoChipAndNoLine() {
        mount(call(2, "bgj_a1", "Watch PR #212 checks") + wakeTurn(9, wakeBlock("bgj_a1", "new output｜running", "check \"Swift\" → success (3 of 6 done)")),
            JobCards(live = true))
        on("job-mark:running").assertExists()
        all("job-quiet").assertCountEquals(0); all("job-exit").assertCountEquals(0)
        assertEquals("check \"Swift\" → success (3 of 6 done)", textOf(on("job-live-line")))
        all("background-wake").assertCountEquals(0)
        all("event:9").assertCountEquals(0)
        shot("07-new-output")
    }

    @Test fun endedButNotReadSaysSoOnTheCardWithDontSend() {
        var withdrawn = 0
        mount(call(2, "bgj_a1"), JobCards(live = true, queued = mapOf("bgj_a1" to { withdrawn++ }),
            shells = mapOf("bgj_a1" to shell("bgj_a1", "status" to "failed", "terminal" to "failed", "exitCode" to 1, "endedAt" to endedAt,
                "latestOutput" to "X JavaScript in 11m58s — cancelled\nrun ended before JavaScript finished: completed cancelled"))))
        on("job-exit").assertTextEquals("exit 1")
        assertEquals(listOf("Waiting for the agent to read it ·", "Don't send"), texts("subagent-queued"))
        shot("08-waiting-to-be-read")
        on("subagent-dont-send").performClick(); settle()
        assertEquals(1, withdrawn)
    }

    // MARK: the opened card

    @Test fun openedItShowsTheCommandWhereItRanItsLast40LinesAndEachWake() {
        val output = (1..214).joinToString("\n") { "line $it" }
        val events = call(2, "bgj_a1") + wakeTurn(9, wakeBlock("bgj_a1", "ended｜failed｜exit code 1", "Refreshing run status every 30 seconds.\nrun ended before JavaScript finished: completed cancelled"))
        mount(events, JobCards(where = "workstation", shells = mapOf("bgj_a1" to shell("bgj_a1", "status" to "failed", "terminal" to "failed",
            "exitCode" to 1, "endedAt" to endedAt, "latestOutput" to output))))
        on("job-row").performClick(); settle()
        // A failed job's opened output keeps the normal text colour; only the folded lines turn red (web `.chat-job-output`).
        assertEquals(androidx.compose.ui.graphics.Color(0xFF1C1C1E), colorOf(on("job-output-text")))
        on("job-command").assertTextEquals("$ gh run watch 19632123456 --exit-status --interval 30")
        val meta = textOf(on("job-meta"))
        assertTrue(meta, Regex("^bgj_a1 · watch · started \\d\\d:\\d\\d · ran 12m 4\\ds · on workstation$").matches(meta))
        // The end's wake carried two lines: all of them shown, no Show all.
        all("job-show-all").assertCountEquals(0)
        on("job-wakes-head").assertTextEquals("Woke the agent 1 time")
        assertTrue(textOf(on("job-wake:0")), textOf(on("job-wake:0")).matches(Regex("^\\d\\d:\\d\\d · exit 1 · read by the agent at \\d\\d:\\d\\d$")))
        all("job-wake-raw-text:0").assertCountEquals(0)
        on("job-wake-raw:0").performClick(); settle()
        assertTrue(textOf(on("job-wake-raw-text:0")).startsWith("<background-job-wake>"))
        shot("09-opened")
    }

    @Test fun openedALongOutputShowsItsLast40LinesThenAll() {
        val output = (1..214).joinToString("\n") { "line $it" }
        mount(call(2, "bgj_a1"), JobCards(shells = mapOf("bgj_a1" to shell("bgj_a1", "status" to "done", "terminal" to "done", "exitCode" to 0,
            "endedAt" to endedAt, "latestOutput" to output))))
        on("job-row").performClick(); settle()
        val shown = textOf(compose.onNode(hasAnyAncestor(hasTestTag("job-output")) and hasText("line 214", substring = true), useUnmergedTree = true))
        assertEquals((175..214).joinToString("\n") { "line $it" }, shown)
        on("job-show-all").assertTextEquals("Show all 214 lines").performClick(); settle()
        assertTrue(textOf(compose.onNode(hasAnyAncestor(hasTestTag("job-output")) and hasText("line 214", substring = true), useUnmergedTree = true))
            .startsWith("line 1\nline 2\n"))
        all("job-show-all").assertCountEquals(0)
    }

    // MARK: Stop (R3)

    @Test fun stopAsksFirstThenCallsTheStopRoute() {
        val stopped = mutableListOf<String>()
        mount(call(2, "bgj_a1"), JobCards(live = true, stop = { stopped += it },
            shells = mapOf("bgj_a1" to shell("bgj_a1", "status" to "running", "stoppable" to true))))
        on("job-row").performClick(); settle()
        on("job-stop").performClick(); settle()
        compose.onNodeWithText("Stop this job?").assertExists()
        on("job-stop-cancel").performClick(); settle()
        assertEquals(emptyList<String>(), stopped)
        on("job-stop").performClick(); settle()
        on("job-stop-confirm").performClick(); settle()
        assertEquals(listOf("bgj_a1"), stopped)
        all("job-stop-dialog").assertCountEquals(0)
    }

    @Test fun theFoldedCardsLongPressOffersStop() {
        val stopped = mutableListOf<String>()
        mount(call(2, "bgj_a1"), JobCards(live = true, stop = { stopped += it },
            shells = mapOf("bgj_a1" to shell("bgj_a1", "status" to "running", "stoppable" to true))))
        on("job-row").performTouchInput { longClick() }; settle()
        on("job-menu-stop").performClick(); settle()
        on("job-stop-confirm").performClick(); settle()
        assertEquals(listOf("bgj_a1"), stopped)
    }

    @Test fun stopIsHiddenWhenTheListMarksTheJobNotStoppable() {
        listOf(shell("bgj_a1", "status" to "running", "stoppable" to false), shell("bgj_a1", "status" to "running")).forEach { row ->
            mount(call(2, "bgj_a1"), JobCards(live = true, stop = { fail("not stoppable") }, shells = mapOf("bgj_a1" to row)))
            // Folded, the row has no long press to offer Stop on; opened, no Stop.
            on("job-row").assert(SemanticsMatcher.keyNotDefined(androidx.compose.ui.semantics.SemanticsActions.OnLongClick))
            on("job-row").performClick(); settle()
            on("job-detail").assertExists()
            all("job-stop").assertCountEquals(0)
            on("job-row").performClick(); settle()
        }
        // And a stoppable job's row has it.
        mount(call(2, "bgj_a1"), JobCards(live = true, stop = { }, shells = mapOf("bgj_a1" to shell("bgj_a1", "status" to "running", "stoppable" to true))))
        on("job-row").assert(SemanticsMatcher.keyIsDefined(androidx.compose.ui.semantics.SemanticsActions.OnLongClick))
    }

    // MARK: the turns its wakes opened (C1)

    @Test fun aJobsWakeTurnDrawsNothingAndAScheduledWakeupStillDraws() {
        val end = wakeBlock("bgj_a1", "ended｜completed｜exit code 0", "done")
        mount(call(2, "bgj_a1") + wakeTurn(9, end) + wakeTurn(10, stallBlock("bgj_q1")) + wakeTurn(11, wakeup) + wakeTurn(12, "$end\n\n$wakeup"),
            JobCards(live = true))
        all("event:9").assertCountEquals(0)
        all("event:10").assertCountEquals(0)
        compose.onAllNodes(hasTestTag("background-wake") and hasAnyAncestor(hasTestTag("event:11")), useUnmergedTree = true).assertCountEquals(1)
        compose.onAllNodes(hasTestTag("background-wake") and hasAnyAncestor(hasTestTag("event:12")), useUnmergedTree = true).assertCountEquals(1)
        all("background-wake").assertCountEquals(2)
        compose.onAllNodesWithText("Background job", substring = true, useUnmergedTree = true).assertCountEquals(0)
        // Each line names its wakeup (the line measures its wide form too, so the words are counted per line, not as nodes).
        compose.onAllNodes(hasText("check the deploy") and hasAnyAncestor(hasTestTag("event:11")), useUnmergedTree = true).fetchSemanticsNodes()
            .let { assertTrue(it.isNotEmpty()) }
    }

    @Test fun theQueuedTailLeavesAJobsNewsToItsCard() {
        fun listed(id: String, content: String, kind: String = "message") = buildJsonObject {
            put("turnId", id); put("content", content); put("kind", kind); put("authoredByOrbit", true) }
        val end = wakeBlock("bgj_a1", "ended｜failed｜exit code 1", "boom")
        val tail = queuedTail(listOf(listed("t-job", end), listed("t-both", "$end\n\n$wakeup"), listed("t-steer", wakeBlock("bgj_b2",
            "ended｜completed｜exit code 0", null), "steer")), emptyList())
        assertEquals(listOf(false, true, false), tail.map { it.inTail() })
        assertNull(tail[0].wake)
        assertTrue(BgJob.jobIds(tail[1].wake!!).isEmpty())
        assertTrue(tail.none { it.readersOwn || it.inTray })
        val withdrawn = mutableListOf<String>()
        val waits = jobQueuedWakes(tail, cancelEnabled = true) { withdrawn += it }
        // A steer is on its way into the running turn and cannot be withdrawn: no entry for it.
        assertEquals(setOf("bgj_a1"), waits.keys)
        waits.getValue("bgj_a1")!!.invoke()
        assertEquals(listOf("t-both"), withdrawn)
        assertTrue(jobQueuedWakes(tail, cancelEnabled = false) { }.values.all { it == null })
    }

    // MARK: the frames

    /** Every folded state in one frame at phone width, as the board's panel ② lays them out. */
    @Config(qualifiers = "w411dp-h1400dp-xhdpi")
    @Test fun everyFoldedStateInOneFrame() {
        val ids = listOf("bgj_r", "bgj_d", "bgj_f", "bgj_q", "bgj_k", "bgj_s", "bgj_n", "bgj_w")
        val events = call(2, "bgj_r", "Full web test suite", "job") + call(4, "bgj_d", "Full web test suite", "job") +
            call(6, "bgj_f", "Build apiserver image", "job") + call(8, "bgj_q", "Deploy 5dd308afd", "job") +
            call(10, "bgj_k", "Android unit tests", "job") + call(12, "bgj_s", "npm run dev", "service", "npm run dev") +
            call(14, "bgj_n", "Watch PR #212 checks") + call(16, "bgj_w") +
            wakeTurn(30, wakeBlock("bgj_f", "ended｜failed｜exit code 1", "npm error network ECONNRESET\nERROR: process \"/bin/sh -c npm ci\" did not complete: exit code 1")) +
            wakeTurn(31, stallBlock("bgj_q")) + wakeTurn(32, wakeBlock("bgj_n", "new output｜running", "check \"Swift\" → success (3 of 6 done)"))
        val tails = mapOf("bgj_r" to tailOf("running", "✓ src/components/Transcript.test.tsx (412 tests) 9.8s"),
            "bgj_s" to tailOf("running", "  ➜  Local:   http://localhost:5173/"))
        mount(events, JobCards(live = true, where = "workstation", tail = { tails[it] ?: tailOf("running") },
            queued = mapOf("bgj_w" to {}),
            shells = mapOf(
                "bgj_d" to shell("bgj_d", "status" to "done", "terminal" to "done", "exitCode" to 0, "endedAt" to endedAt,
                    "latestOutput" to "Test Files  641 passed (641)\n     Tests  8723 passed (8723)"),
                "bgj_k" to shell("bgj_k", "status" to "killed", "terminal" to "killed", "reason" to "stopped_by_owner", "endedAt" to endedAt),
                "bgj_w" to shell("bgj_w", "status" to "failed", "terminal" to "failed", "exitCode" to 1, "endedAt" to endedAt,
                    "latestOutput" to "X JavaScript in 11m58s — cancelled\nrun ended before JavaScript finished: completed cancelled"))))
        ids.forEach { on("job-card:$it").assertExists() }
        shot("00-folded-states")
    }

    private fun frame(): Bitmap {
        compose.waitForIdle()
        val decor = compose.activity.window.decorView
        return Bitmap.createBitmap(decor.width, decor.height, Bitmap.Config.ARGB_8888).also { decor.draw(Canvas(it)) }
    }

    private fun shot(name: String) {
        // The spinner a few frames on, so a still frame shows its arc.
        frames(300)
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }.first { File(it, "src/android").isDirectory }
        val output = File(root, "src/android/build/evidence/job-card-android").also { it.mkdirs() }
        val bitmap = frame()
        File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }
}
