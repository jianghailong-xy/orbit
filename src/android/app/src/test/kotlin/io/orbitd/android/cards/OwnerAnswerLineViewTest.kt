package io.orbitd.android.cards

import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.cards.CardCatalog
import io.orbitd.android.core.cards.CoordinatorQuestions
import io.orbitd.android.core.cards.CoordinatorQueue
import io.orbitd.android.core.cards.OwnerAnswerLine
import io.orbitd.android.core.cards.OwnerReview
import io.orbitd.android.core.cards.transcriptCards
import io.orbitd.android.core.realtime.RunEvent
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.reader.QueuedTurnRow
import io.orbitd.android.reader.queuedTail
import java.time.Instant
import kotlinx.serialization.json.*
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The owner's answer handed to the coordinator, as the reader draws it (web OwnerAnswerLine.test.tsx, iOS OwnerAnswerLineView). Where the
 * conversation holds the question it answers, the turn is that question's own Answered card — dashed and saying so while it waits on the
 * queue, with no way out; saying so when its delivery went unconfirmed; the words the agent read folded in its review — and nothing else
 * (docs/mocks/owner-answer-sent-card/merged.html). Otherwise it is one line, "Sent to the coordinator · 08:29", that opens to those words,
 * and the same line while it still waits on the queue. */
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
    private val item = "01a0d6a9-d763-70e1-b4cf-8793e971b511"

    private fun show(content: @Composable () -> Unit) {
        compose.runOnUiThread { compose.activity.setContent { MaterialTheme { content() } } }
        compose.waitForIdle()
    }

    /** [content] in a conversation holding [questions]. */
    private fun answering(questions: AnsweredQuestions, content: @Composable () -> Unit) =
        show { CompositionLocalProvider(LocalAnsweredQuestions provides questions) { content() } }

    /** The turn handing the answer over, as its echo; a Not yet… to a request to record the project done is [kind] DONE_REQUEST. */
    private fun turn(kind: String = "COORDINATOR_QUESTION", delivery: String? = null) = RunEvent("user", 9, buildJsonObject {
        put("text", told); put("ownerAnswer", JsonObject(answer + ("kind" to JsonPrimitive(kind)))); delivery?.let { put("delivery", it) }
    }, "turn-answer")

    /** The question's ended record as the open-items read carries it, under [itemId] as that read spells it. */
    private fun record(itemId: String = item) = CardCatalog.project("s1", "p1", mapOf("project" to buildJsonObject { put("id", "p1") },
        "openItems" to buildJsonObject { putJsonArray("needsYou") {}; putJsonArray("closedQuestions") { addJsonObject {
            put("itemId", itemId); put("askedAt", "2026-10-09T00:10:00.000Z")
            putJsonObject("question") {
                put("question", "Merge now, or wait for the review?"); put("recommendedOption", 0)
                putJsonArray("options") { addJsonObject { put("label", "Merge now") }; addJsonObject { put("label", "Wait for the review") } }
            }
            put("resolution", "ANSWERED"); put("resolvedBy", "USER"); put("resolvedAt", delivered)
            putJsonObject("answer") { put("option", 1); put("text", JsonNull) }
            putJsonObject("delivery") { put("sessionId", "01a0d6a9-d763-70e1-b4cf-8793e971b512"); put("at", delivered) }
            put("withdrawReason", JsonNull)
        } } })).single()

    private fun queuedTurn() = queuedTail(listOf(buildJsonObject {
        put("turnId", "t1"); put("kind", "message"); put("content", told); putJsonArray("attachments") {}
        put("ownerAnswer", answer); put("authoredByOrbit", true)
    }), emptyList()).single()

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
        val turn = queuedTurn()
        show { QueuedTurnRow(turn, {}, cancelEnabled = true) {} }

        compose.onNodeWithText(line, useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithTag("queued-foot:cancel", useUnmergedTree = true).assertIsDisplayed()
        compose.onAllNodesWithText("You", useUnmergedTree = true).assertCountEquals(0)
        compose.onAllNodesWithText(told, useUnmergedTree = true).assertCountEquals(0)
    }

    @Test fun whereTheConversationHoldsTheQuestionTheTurnIsItsAnsweredCard() {
        val record = record()
        val event = turn()
        var opened: String? = null
        answering(AnsweredQuestions(listOf(record), listOf(event)) { opened = it }) { TranscriptCardView(transcriptCards(event).single(), {}, event) }

        compose.onNode(hasTestTag(record.key) and hasAnyAncestor(hasTestTag("record:9:ownerAnswer"))).assertIsDisplayed()
        compose.onNodeWithTag("${record.key}:heading", useUnmergedTree = true).assertTextEquals(CoordinatorQuestions.answeredHeading)
        compose.onNodeWithTag("${record.key}:answer", useUnmergedTree = true).assertTextEquals("Wait for the review")
        compose.onAllNodesWithText(line, useUnmergedTree = true).assertCountEquals(0)
        compose.onAllNodesWithText(told, useUnmergedTree = true).assertCountEquals(0)
        listOf("queued", "notice", "waiting").forEach { compose.onNodeWithTag("${record.key}:$it", useUnmergedTree = true).assertDoesNotExist() }

        compose.onNodeWithTag(record.key).performClick()
        assertEquals("View details opens the record's review", record.key, opened)
    }

    @Test fun itsReviewFoldsWhatTheCoordinatorWasToldAtTheFootOfTheReplay() {
        val record = record()
        val handover = AnsweredQuestions(listOf(record), listOf(turn())) {}.told(record)
        show { Box(Modifier.height(800.dp)) { QuestionRecordReview(record, handover) {} } }
        val fold = "${record.key}:told"
        compose.onNode(hasTestTag(fold) and hasAnyAncestor(hasTestTag("${record.key}:replay")), useUnmergedTree = true).assertExists()
        compose.onAllNodesWithText(told, useUnmergedTree = true).assertCountEquals(0)

        compose.onNodeWithText(OwnerAnswerLine.told).performClick()
        compose.waitForIdle()
        compose.onNodeWithTag("$fold:words", useUnmergedTree = true).assertTextEquals(told)

        // A record no turn of the conversation told is replayed without them.
        show { Box(Modifier.height(800.dp)) { QuestionRecordReview(record, AnsweredQuestions(listOf(record), emptyList()) {}.told(record)) {} } }
        compose.onNodeWithTag(fold, useUnmergedTree = true).assertDoesNotExist()
    }

    @Test fun anUnconfirmedDeliveryIsSaidOnTheCard() {
        val record = record()
        val event = turn(delivery = "failed")
        answering(AnsweredQuestions(listOf(record), listOf(event)) {}) { TranscriptCardView(transcriptCards(event).single(), {}, event) }

        compose.onNodeWithTag("${record.key}:notice", useUnmergedTree = true).assertTextEquals(OwnerAnswerLine.undelivered)
        compose.onAllNodesWithText(OwnerAnswerLine.undelivered, useUnmergedTree = true).assertCountEquals(1)
        compose.onNodeWithTag("${record.key}:queued", useUnmergedTree = true).assertDoesNotExist()
        compose.onAllNodesWithText(line, useUnmergedTree = true).assertCountEquals(0)
    }

    /** Still on the queue, the card is dashed and says so, and the queue's Cancel is gone: the answer is given, and withdrawing the turn
     * would leave the coordinator never told. */
    @Test fun aQueuedAnswerIsTheCardSayingItWaitsWithNoWayOut() {
        val record = record()
        val turn = queuedTurn()
        answering(AnsweredQuestions(listOf(record), listOf(turn.event)) {}) { QueuedTurnRow(turn, {}, cancelEnabled = true) {} }

        compose.onNodeWithTag("${record.key}:queued", useUnmergedTree = true).assertTextEquals(CoordinatorQuestions.queuedForCoordinator)
        compose.onNodeWithTag("${record.key}:heading", useUnmergedTree = true).assertTextEquals(CoordinatorQuestions.answeredHeading)
        compose.onNodeWithTag("queued-foot", useUnmergedTree = true).assertDoesNotExist()
        compose.onAllNodesWithText("Cancel", useUnmergedTree = true).assertCountEquals(0)
        compose.onAllNodesWithText(line, useUnmergedTree = true).assertCountEquals(0)
        compose.onAllNodesWithText("You", useUnmergedTree = true).assertCountEquals(0)
        compose.onAllNodesWithText(told, useUnmergedTree = true).assertCountEquals(0)
    }

    @Test fun aNotYetAndAQuestionTheConversationDoesNotHoldKeepTheLine() {
        val record = record()
        val notYet = turn(kind = "DONE_REQUEST")
        answering(AnsweredQuestions(listOf(record), listOf(notYet)) {}) { TranscriptCardView(transcriptCards(notYet).single(), {}, notYet) }
        compose.onNodeWithText(line, useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithTag(record.key, useUnmergedTree = true).assertDoesNotExist()

        val event = turn()
        answering(AnsweredQuestions(emptyList(), listOf(event)) {}) { TranscriptCardView(transcriptCards(event).single(), {}, event) }
        compose.onNodeWithText(line, useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithTag(record.key, useUnmergedTree = true).assertDoesNotExist()
    }

    /** The open-items read names the item by its public id; the turn's card carries the UUID. */
    @Test fun theQuestionIsFoundWhicheverSpellingEachReadWasServed() {
        val record = record(ObjectId.toPublic(item))
        val event = turn()
        answering(AnsweredQuestions(listOf(record), listOf(event)) {}) { TranscriptCardView(transcriptCards(event).single(), {}, event) }
        compose.onNodeWithTag("${record.key}:heading", useUnmergedTree = true).assertTextEquals(CoordinatorQuestions.answeredHeading)
        compose.onAllNodesWithText(line, useUnmergedTree = true).assertCountEquals(0)
    }
}
