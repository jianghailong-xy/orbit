package io.orbitd.android.cards

import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.cards.CoordinatorDeliveryLine
import io.orbitd.android.core.cards.OwnerAnswerLine
import io.orbitd.android.core.cards.transcriptCards
import io.orbitd.android.core.realtime.RunEvent
import io.orbitd.android.reader.QueuedTurnRow
import io.orbitd.android.reader.SteerDelivery
import io.orbitd.android.reader.queuedTail
import java.time.Instant
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * A fact told to this session, as the reader draws it: one line — its sentence, then "Sent to the coordinator · 19:30" — that opens to
 * the words the agent read and to the task it names; the same line while it still waits on the queue; and, unconfirmed, the words every
 * Orbit card says, with nothing to put back in the composer (web CoordinatorDeliveryLine.test.tsx, iOS CoordinatorDeliveryLineView).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h891dp")
class CoordinatorDeliveryLineViewTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    private val title = "Wiki model queue: one claim can take more requests than the concurrency room"
    private val told = "From Orbit · project “Runner link v1” has a revision of completion evidence for you to decide\n\n" +
        "Task “$title” (34nmQgDgyywHNIUtjb9TD) submitted revision 1 of its completion evidence."
    private val delivered = Instant.now().toString()
    private fun delivery(kind: String = "EVIDENCE_SUBMITTED", task: Boolean = true) = buildJsonObject {
        put("kind", kind)
        if (task) putJsonObject("task") { put("id", "34nmQgDgyywHNIUtjb9TD"); put("title", title) } else put("task", JsonNull)
        put("revision", 1); put("count", JsonNull); put("deliveredAt", delivered)
    }
    private val sentence = "Evidence revision 1 submitted: $title"
    private val sent get() = CoordinatorDeliveryLine.sent(CoordinatorDeliveryLine.parse(delivery())!!)
    private fun echo(card: JsonObject = delivery(), extra: JsonObjectBuilder.() -> Unit = {}) =
        RunEvent("user", 9, buildJsonObject { put("text", told); put("coordinatorDelivery", card); extra() }, "turn-delivery")

    private fun show(content: @Composable () -> Unit) {
        compose.runOnUiThread { compose.activity.setContent { MaterialTheme { content() } } }
        compose.waitForIdle()
    }

    @Test fun theFactIsOneLineThatOpensToTheWordsTheAgentReadAndItsTask() {
        val opened = mutableListOf<String>()
        val event = echo()
        show { TranscriptCardView(transcriptCards(event).single(), { opened += it }, event) }

        compose.onNodeWithText(sentence, useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithText(sent, useUnmergedTree = true).assertIsDisplayed()
        compose.onAllNodesWithText(told, useUnmergedTree = true).assertCountEquals(0)
        compose.onAllNodesWithText(CoordinatorDeliveryLine.itsTask, useUnmergedTree = true).assertCountEquals(0)

        compose.onNodeWithText(sentence, useUnmergedTree = true).performClick()
        compose.waitForIdle()
        compose.onNodeWithText(OwnerAnswerLine.told, useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithText(told, useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithText(CoordinatorDeliveryLine.itsTask, useUnmergedTree = true).performScrollTo().performClick()
        compose.waitForIdle()
        assertEquals(listOf("orbit-task:34nmQgDgyywHNIUtjb9TD"), opened)
        compose.onAllNodesWithText(OwnerAnswerLine.told, useUnmergedTree = true).assertCountEquals(0)
    }

    /** At a phone's width the sentence takes the first row and when it was sent the second (the design's phone board). */
    @Test fun atAPhonesWidthTheSentenceAndTheTimeTakeARowEach() {
        val event = echo()
        show { TranscriptCardView(transcriptCards(event).single(), {}, event) }
        val words = compose.onNodeWithTag("record:9:coordinatorDelivery:sentence", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
        val time = compose.onNodeWithTag("record:9:coordinatorDelivery:sent", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
        assertTrue("the time is under the sentence: $words / $time", time.top >= words.bottom)
    }

    /** With a tablet's room the two share the row, the sentence first. */
    @Config(qualifiers = "w900dp-h600dp")
    @Test fun withATabletsRoomTheyShareTheRow() {
        val event = echo()
        show { TranscriptCardView(transcriptCards(event).single(), {}, event) }
        val words = compose.onNodeWithTag("record:9:coordinatorDelivery:sentence", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
        val time = compose.onNodeWithTag("record:9:coordinatorDelivery:sent", useUnmergedTree = true).fetchSemanticsNode().boundsInRoot
        assertTrue("one row: $words / $time", time.top < words.bottom && time.left >= words.right)
    }

    @Test fun aFactThatNamesNoTaskOffersNone() {
        val card = delivery("LOOKS_FINISHED", task = false)
        val event = echo(card)
        show { TranscriptCardView(transcriptCards(event).single(), {}, event) }
        compose.onNodeWithText("Looks finished, not recorded Done", useUnmergedTree = true).assertIsDisplayed().performClick()
        compose.waitForIdle()
        compose.onNodeWithText(OwnerAnswerLine.told, useUnmergedTree = true).assertIsDisplayed()
        compose.onAllNodesWithText(CoordinatorDeliveryLine.itsTask, useUnmergedTree = true).assertCountEquals(0)
    }

    /** Unconfirmed, the line says so in every Orbit card's words — and offers none of the agent's words back to the composer. */
    @Test fun anUndeliveredFactSaysSoAndPutsNothingBack() {
        listOf("failed", "unconfirmed").forEach { state ->
            val event = echo { put("delivery", state) }
            show { TranscriptCardView(transcriptCards(event).single(), {}, event) }
            compose.onNodeWithText(OwnerAnswerLine.undelivered, useUnmergedTree = true).assertIsDisplayed()
            compose.onAllNodesWithText(SteerDelivery.PUT_BACK, useUnmergedTree = true).assertCountEquals(0)
        }
        // The latest word on the turn is a runner's `user_delivery`, read over the echo's own.
        val event = echo()
        show {
            androidx.compose.runtime.CompositionLocalProvider(LocalSteerDeliveries provides mapOf("turn-delivery" to "failed")) {
                TranscriptCardView(transcriptCards(event).single(), {}, event)
            }
        }
        compose.onNodeWithText(OwnerAnswerLine.undelivered, useUnmergedTree = true).assertIsDisplayed()
        assertFalse("nobody typed it", SteerDelivery.readersOwn(event))
    }

    @Test fun aQueuedFactWaitsAsTheSameLineWithTheQueuesWayOut() {
        val turn = queuedTail(listOf(buildJsonObject {
            put("turnId", "t1"); put("kind", "message"); put("content", told); putJsonArray("attachments") {}
            put("coordinatorDelivery", delivery()); put("authoredByOrbit", true)
        }), emptyList()).single()
        show { QueuedTurnRow(turn, {}, cancelEnabled = true) {} }

        compose.onNodeWithText(sentence, useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithTag("queued-foot:cancel", useUnmergedTree = true).assertIsDisplayed()
        compose.onAllNodesWithText("You", useUnmergedTree = true).assertCountEquals(0)
        compose.onAllNodesWithText(told, useUnmergedTree = true).assertCountEquals(0)
    }
}
