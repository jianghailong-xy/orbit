package io.orbitd.android.cards

import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.height
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.cards.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** A coordinator's question once it ended, as the conversation draws it (A08-13; iOS `CoordinatorQuestionRecordView`): folded where its
 * card was — heading, time, opening, answer, note, the orange wait, or who withdrew it and why — and replayed in its review, the
 * answer ticked over every option as it was offered, with who ended it and where the answer went. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h891dp")
class QuestionRecordViewsTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val key = "item:item-1"
    private val question = buildJsonObject {
        put("question", "The rollback's follow-ups are done:\n\n- maintenance resumed\n- **all three fixes** shipped\n\nApprove reopening the rollout.")
        putJsonArray("options") {
            addJsonObject { put("label", "Reopen now"); put("description", "No special timing.") }
            addJsonObject { put("label", "Switch at the next round") }
        }
        put("recommendedOption", 0)
    }
    private fun closed(option: Int?, text: String?, delivered: Boolean, withdrawnBy: String? = null) = buildJsonObject {
        put("itemId", "item-1"); put("question", question); put("askedAt", "2026-10-09T00:10:00.000Z")
        put("resolution", if (withdrawnBy == null) "ANSWERED" else "WITHDRAWN"); put("resolvedBy", withdrawnBy ?: "USER")
        put("resolvedAt", "2026-10-09T00:29:36.828Z")
        if (withdrawnBy == null) putJsonObject("answer") { put("option", option?.let(::JsonPrimitive) ?: JsonNull); put("text", text) } else put("answer", JsonNull)
        put("delivery", if (delivered) buildJsonObject { put("sessionId", "c1"); put("at", "2026-10-09T00:29:37.000Z") } else JsonNull)
        put("withdrawReason", if (withdrawnBy == null) null else "Not needed after the rollback.")
    }
    private fun card(record: JsonObject) = CardCatalog.project("s1", "p1", mapOf("project" to buildJsonObject { put("id", "p1") },
        "openItems" to buildJsonObject { putJsonArray("needsYou") {}; putJsonArray("closedQuestions") { add(record) } })).single()

    @Test fun theFoldedRecordSaysWhatWasAskedAndHowItEnded() {
        var opened = 0
        val card = card(closed(option = 1, text = " After 22:00. ", delivered = false))
        assertEquals(CardFamily.QUESTION_RECORD, card.family)
        compose.runOnUiThread { compose.activity.setContent { MaterialTheme { QuestionRecordCard(card) { opened++ } } } }
        compose.onNodeWithTag("$key:heading", useUnmergedTree = true).assertTextEquals("Answered")
        compose.onNodeWithText(CoordinatorQuestions.time(card.source)!!, useUnmergedTree = true).assertExists()
        compose.onNodeWithTag("$key:lead", useUnmergedTree = true)
            .assertTextEquals("The rollback's follow-ups are done: maintenance resumed all three fixes shipped Approve reopening the rollout.")
        compose.onNodeWithTag("$key:answer", useUnmergedTree = true).assertTextEquals("Switch at the next round")
        compose.onNodeWithTag("$key:note", useUnmergedTree = true).assertTextEquals("“After 22:00.”")
        compose.onNodeWithTag("$key:waiting", useUnmergedTree = true).assertTextEquals("Waiting for this project’s next coordinator")
        compose.onNodeWithTag("$key:withdrew", useUnmergedTree = true).assertDoesNotExist()
        compose.onNodeWithText("View details", useUnmergedTree = true).assertExists()
        compose.onNodeWithTag(key).performClick()
        assertEquals(1, opened)
    }

    @Test fun aWithdrawnRecordSaysWhoTookItBackAndWhy() {
        val card = card(closed(option = null, text = null, delivered = false, withdrawnBy = "USER"))
        compose.runOnUiThread { compose.activity.setContent { MaterialTheme { QuestionRecordCard(card) {} } } }
        compose.onNodeWithTag("$key:heading", useUnmergedTree = true).assertTextEquals("Withdrawn")
        compose.onNodeWithTag("$key:withdrew", useUnmergedTree = true).assertTextEquals("You withdrew it")
        compose.onNodeWithTag("$key:reason", useUnmergedTree = true).assertTextEquals("“Not needed after the rollback.”")
        compose.onNodeWithTag("$key:answer", useUnmergedTree = true).assertDoesNotExist()
        compose.onNodeWithTag("$key:waiting", useUnmergedTree = true).assertDoesNotExist()
    }

    @Test fun theReplayTicksTheAnswerOverEveryOptionAndSaysWhereItWent() {
        val card = card(closed(option = 1, text = "After 22:00.", delivered = true))
        compose.runOnUiThread { compose.activity.setContent { MaterialTheme { Box(Modifier.height(800.dp)) { QuestionRecordReview(card) {} } } } }
        compose.onNodeWithText(CoordinatorQuestions.provenance, useUnmergedTree = true).assertExists()
        compose.onNodeWithTag("$key:option:0:recommended", useUnmergedTree = true).assertTextEquals("Recommended")
        compose.onNodeWithTag("$key:option:0:chosen", useUnmergedTree = true).assertDoesNotExist()
        compose.onNodeWithTag("$key:option:1:chosen", useUnmergedTree = true).assertExists()
        compose.onNodeWithTag("$key:option:1:words", useUnmergedTree = true).assertExists()
        compose.onNodeWithText(CoordinatorQuestions.yourNote, useUnmergedTree = true).assertExists()
        compose.onNodeWithText("After 22:00.", useUnmergedTree = true).assertExists()
        compose.onNodeWithTag("$key:option:other", useUnmergedTree = true).assertDoesNotExist()
        compose.onNodeWithTag("$key:footer-line", useUnmergedTree = true).assertTextEquals("Answered by you · ${CoordinatorQuestions.time(card.source)}")
        compose.onNodeWithTag("$key:footer-detail", useUnmergedTree = true).assertTextEquals("Delivered to the current coordinator")
    }

    @Test fun ownWordsTickTheOtherRow() {
        val card = card(closed(option = null, text = "Hold the files.", delivered = false))
        compose.runOnUiThread { compose.activity.setContent { MaterialTheme { Box(Modifier.height(800.dp)) { QuestionRecordReview(card) {} } } } }
        compose.onNodeWithTag("$key:option:other:chosen", useUnmergedTree = true).assertExists()
        compose.onNodeWithText(CoordinatorQuestions.otherOption, useUnmergedTree = true).assertExists()
        compose.onNodeWithTag("$key:option:0:chosen", useUnmergedTree = true).assertDoesNotExist()
        compose.onNodeWithTag("$key:footer-detail", useUnmergedTree = true).assertTextEquals("Waiting for this project’s next coordinator")
    }
}
