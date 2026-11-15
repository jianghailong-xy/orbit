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
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.realtime.RunEvent
import io.orbitd.android.reader.LocalSubagentCardJump
import io.orbitd.android.reader.SteerDelivery
import io.orbitd.android.reader.StickySummary
import io.orbitd.android.reader.TranscriptRowView
import io.orbitd.android.reader.queuedTail
import io.orbitd.android.reader.transcriptRows
import io.orbitd.android.core.cards.transcriptCards
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
 * A SubAgent's finished wake in the transcript (board docs/mocks/subagent-finished-line; web `Transcript.subagentFinished.test.tsx`): one
 * line in the agent's stream drawn by the production [TranscriptRowView] — the purple ✦, how it ended, a status chip, three lines of the
 * result as Markdown with Show full result, a Details fold — never `⊕ Orbit attached: context` over the raw block, and never the block's
 * sentences for the agent outside "What the agent read". The blocks are the web's fixtures (the apiserver's own output), read from that
 * file. Frames go to `src/android/build/evidence/subagent-finished-line-android/`.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h891dp-xhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class SubagentFinishedLineTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    private val repo = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
        .first { File(it, "src/web/src/lib/subagentFinished.fixtures.ts").isFile }
    private val fixtures: Map<String, String> = Regex("export const (SUBAGENT_\\w+) =\\s*\\n\\s*(\"(?:[^\"\\\\]|\\\\.)*\");")
        .findAll(File(repo, "src/web/src/lib/subagentFinished.fixtures.ts").readText())
        .associate { it.groupValues[1] to (Json.parseToJsonElement(it.groupValues[2]) as JsonPrimitive).content }

    /** The sentences the block closes on: the agent's, never shown outside "What the agent read". */
    private val protocol = listOf("The control plane opened this turn for it", "It ended while you were working", "the user did not say it",
        "call delegate with resume", "review it before you commit")

    private val ago = Instant.now().minusSeconds(130).toString()

    /** A `user` event as ingest stores a wake turn: the echo, and the same block recorded as the note. */
    private fun wake(block: String, extra: JsonObjectBuilder.() -> Unit = {}) = RunEvent("user", 9, buildJsonObject {
        put("text", block); put("controlPlaneNote", block); extra()
    }, "turn-wake", ago)

    private fun say(seq: Long, text: String) = RunEvent("assistant", seq, buildJsonObject { put("text", text) }, "turn-1", ago)

    private fun show(wake: RunEvent, dark: Boolean = false, jump: (String) -> (() -> Unit)? = { null }) {
        val events = listOf(
            RunEvent("user", 1, buildJsonObject { put("text", "Deploy 6bb50a957 and fix the card.") }, "turn-1", ago),
            say(2, "I'll hand the deploy to a SubAgent and keep going on the card fix."),
            wake,
            say(10, "Another release is mid-build, so I'll wait for PID 916891 to exit before retrying the deploy."))
        val rows = transcriptRows(events)
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme(darkTheme = dark) {
            CompositionLocalProvider(LocalSubagentCardJump provides jump) {
                Surface(Modifier.fillMaxSize(), color = MaterialTheme.colorScheme.background) {
                    Column(Modifier.fillMaxWidth().padding(16.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                        rows.forEach { row -> TranscriptRowView(row, { error("no full read") }, null, {}) }
                    }
                }
            }
        } } }
        compose.waitForIdle()
    }

    private fun assertNoProtocol() = protocol.forEach {
        compose.onAllNodes(hasText(it, substring = true), useUnmergedTree = true).assertCountEquals(0)
    }

    private fun assertNotTheReadersBubble() {
        compose.onAllNodes(hasText("Orbit attached", substring = true), useUnmergedTree = true).assertCountEquals(0)
        compose.onAllNodes(hasText("<orbit-subagent-finished>", substring = true), useUnmergedTree = true).assertCountEquals(0)
    }

    /** The line's own words. Its row is laid out wide or stacked ([FitsOrStack]), which composes a measuring copy of the wide row too, so
     * a word of the line may stand twice in the tree: the first is the one drawn. */
    private fun text(words: String) =
        compose.onAllNodes(hasText(words) and hasAnyAncestor(hasTestTag("subagent-finished")), useUnmergedTree = true).onFirst()

    @Test fun aRunThatFinishedIsOneLineWithThreeLinesOfItsResult() {
        show(wake(fixtures.getValue("SUBAGENT_DONE")))
        compose.onNodeWithTag("subagent-finished").assertExists()
        text("SubAgent finished").assertExists()
        text("Deploy 6bb50a957 to production").assertExists()
        text("done").assertExists()
        text("2m ago").assertExists()
        text("Details").assertExists()
        text("Show full result").assertExists()
        assertNotTheReadersBubble()
        assertNoProtocol()
        // Three lines of it: the clamp is shorter than the whole result.
        val clamped = compose.onNodeWithTag("subagent-finished:result").fetchSemanticsNode().size.height
        // On a line's boundary: three of the prose's 24sp lines, at xhdpi.
        assertEquals(3 * 48, clamped)
        shot("01-done")
        compose.onNodeWithTag("subagent-finished:toggle").performClick()
        compose.waitForIdle()
        text("Show less").assertExists()
        assertTrue(compose.onNodeWithTag("subagent-finished:result").fetchSemanticsNode().size.height > clamped * 2)
        assertNoProtocol()
        shot("02-done-full-result")
    }

    @Test fun theFoldOpensToTheRunItsCardWhoQueuedItAndWhatTheAgentRead() {
        val jumped = mutableListOf<String>()
        show(wake(fixtures.getValue("SUBAGENT_DONE")), jump = { runId -> { jumped += runId } })
        compose.onNodeWithTag("subagent-finished:line").performClick()
        compose.waitForIdle()
        text("Run").assertExists()
        text("34y5NxcqKYA179mC04VUB").assertExists()
        text("Changes left in the working tree, uncommitted").assertExists()
        text("Queued by a SubAgent, not typed by you").assertExists()
        text("What the agent read").assertExists()
        assertNoProtocol()
        shot("03-done-details")
        compose.onNodeWithTag("subagent-finished:card-link").assertTextEquals("↑ Its SubAgent card").performClick()
        assertEquals(listOf("34y5NxcqKYA179mC04VUB"), jumped)
        // The sentences for the agent are only in the raw block, once it is opened.
        compose.onNodeWithTag("subagent-finished:raw").performClick()
        compose.waitForIdle()
        compose.onNodeWithTag("subagent-finished:raw-text", useUnmergedTree = true).assert(hasText("the user did not say it", substring = true))
        protocol.forEach { sentence ->
            compose.onAllNodes(hasText(sentence, substring = true), useUnmergedTree = true).assertAll(hasTestTag("subagent-finished:raw-text"))
        }
    }

    @Test fun noCardLinkWhereTheCardIsNotDrawn() {
        show(wake(fixtures.getValue("SUBAGENT_DONE")))
        compose.onNodeWithTag("subagent-finished:line").performClick()
        compose.waitForIdle()
        compose.onAllNodesWithTag("subagent-finished:card-link", useUnmergedTree = true).assertCountEquals(0)
    }

    @Test fun aRunThatDidNotFinishTurnsTheLineRedAndSaysWhy() {
        for (dark in listOf(false, true)) {
            show(wake(fixtures.getValue("SUBAGENT_INTERRUPTED")), dark)
            text("SubAgent did not finish").assertExists()
            text("Port the retry to the Go runner").assertExists()
            text("interrupted").assertExists()
            compose.onNodeWithTag("subagent-finished:reason", useUnmergedTree = true)
                .assert(hasText("The runner process hosting it stopped (a restart, an update or a crash)", substring = true))
            text("No result").assertExists()
            compose.onAllNodesWithTag("subagent-finished:toggle").assertCountEquals(0)
            assertNotTheReadersBubble()
            assertNoProtocol()
            shot(if (dark) "04-did-not-finish-dark" else "04-did-not-finish")
        }
    }

    @Test fun severalRunsAreCountedOnTheLineEachWithARowOfItsOwn() {
        show(wake(fixtures.getValue("SUBAGENT_TWO")))
        text("2 SubAgents finished").assertExists()
        text("1 of 2 failed").assertExists()
        compose.onAllNodesWithTag("subagent-finished:run", useUnmergedTree = true).assertCountEquals(2)
        text("Find every caller of pollQuota").assertExists()
        text("Write the poller spec").assertExists()
        text("failed").assertExists()
        assertNotTheReadersBubble()
        assertNoProtocol()
        shot("05-two-runs")
        compose.onNodeWithTag("subagent-finished:line").performClick()
        compose.waitForIdle()
        text("34y5Qcall0000000000001").assertExists()
        text("34y5Qspec0000000000002").assertExists()
        assertNoProtocol()
        shot("06-two-runs-details")
    }

    @Test fun aWakeWrittenIntoTheRunningTurnSaysHowFarItGot() {
        show(wake(fixtures.getValue("SUBAGENT_STEER")) { put("steer", true); put("delivery", "acknowledged") })
        text("SubAgent finished").assertExists()
        compose.onNodeWithTag("subagent-finished:steer", useUnmergedTree = true).assertTextEquals("Read in this turn")
        assertNotTheReadersBubble()
        assertNoProtocol()
        shot("07-steer")
    }

    @Test fun itIsNeverTheReadersOwnTurn() {
        val done = wake(fixtures.getValue("SUBAGENT_DONE"))
        assertFalse(SteerDelivery.readersOwn(done))
        assertFalse(SteerDelivery.readersSteer(done.copy(payload = buildJsonObject {
            put("text", fixtures.getValue("SUBAGENT_STEER")); put("controlPlaneNote", fixtures.getValue("SUBAGENT_STEER")); put("steer", true) })))
        // A line inside the answer: the sticky bar keeps naming the question above it, and does not hide over it.
        assertFalse(StickySummary.isAnchor(done))
        assertFalse(StickySummary.isOrbits(transcriptCards(done)))
        // Queued, its block is the line it will be, not words to give back to the composer.
        val queued = queuedTail(listOf(buildJsonObject {
            put("turnId", "turn-q"); put("kind", "queued"); put("content", fixtures.getValue("SUBAGENT_DONE")); put("authoredByOrbit", true)
        }), emptyList()).single()
        assertNotNull(queued.subagent)
        assertFalse(queued.readersOwn)
    }

    private fun shot(name: String) {
        compose.waitForIdle()
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
            .first { File(it, "src/android/settings.gradle.kts").isFile }
        val output = File(root, "src/android/build/evidence/subagent-finished-line-android").also { it.mkdirs() }
        val view = compose.activity.window.decorView
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }
}
