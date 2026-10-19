package io.orbitd.android.cards

import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.cards.CoordinatorQueue
import io.orbitd.android.core.cards.OwnerAnswerLine
import io.orbitd.android.core.cards.OwnerReview
import io.orbitd.android.core.cards.transcriptCards
import io.orbitd.android.core.realtime.RunEvent
import io.orbitd.android.reader.QueuedTurnRow
import io.orbitd.android.reader.queuedTail
import java.time.Instant
import kotlinx.serialization.json.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The owner's answer handed to the coordinator, as the reader draws it: one line — "Sent to the coordinator · 08:29" — that opens to the
 * words the agent read, and the same line while it still waits on the queue (web OwnerAnswerLine.test.tsx, iOS OwnerAnswerLineView). */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h891dp")
class OwnerAnswerLineViewTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    private val told = "From Orbit · owner answer: you asked \"Merge now, or wait for the review?\". The owner answered: Wait for the review (2026-10-09T00:29:36.828Z)."
    private val delivered = Instant.now().toString()
    private val answer = buildJsonObject {
        put("itemId", "01a0d6a9-d763-70e1-b4cf-8793e971b511"); put("kind", "COORDINATOR_QUESTION")
        put("sessionId", "01a0d6a9-d763-70e1-b4cf-8793e971b512"); put("deliveredAt", delivered)
    }
    private val line get() = CoordinatorQueue.sentLine(OwnerReview.receiptTime(delivered))

    private fun show(content: @Composable () -> Unit) {
        compose.runOnUiThread { compose.activity.setContent { MaterialTheme { content() } } }
        compose.waitForIdle()
    }

    @Test fun theAnswerIsOneLineThatOpensToTheWordsTheAgentRead() {
        val event = RunEvent("user", 9, buildJsonObject { put("text", told); put("ownerAnswer", answer) }, "turn-answer")
        show { TranscriptCardView(transcriptCards(event).single(), {}, event) }

        compose.onNodeWithText(line, useUnmergedTree = true).assertIsDisplayed()
        compose.onAllNodesWithText(told, useUnmergedTree = true).assertCountEquals(0)

        compose.onNodeWithText(line, useUnmergedTree = true).performClick()
        compose.waitForIdle()
        compose.onNodeWithText(OwnerAnswerLine.told, useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithText(told, useUnmergedTree = true).assertIsDisplayed()
    }

    @Test fun aQueuedAnswerWaitsAsTheSameLineWithTheQueuesWayOut() {
        val turn = queuedTail(listOf(buildJsonObject {
            put("turnId", "t1"); put("kind", "message"); put("content", told); putJsonArray("attachments") {}
            put("ownerAnswer", answer); put("authoredByOrbit", true)
        }), emptyList()).single()
        show { QueuedTurnRow(turn, {}, cancelEnabled = true) {} }

        compose.onNodeWithText(line, useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithTag("queued-foot:cancel", useUnmergedTree = true).assertIsDisplayed()
        compose.onAllNodesWithText("You", useUnmergedTree = true).assertCountEquals(0)
        compose.onAllNodesWithText(told, useUnmergedTree = true).assertCountEquals(0)
    }
}
