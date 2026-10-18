package io.orbitd.android.cards

import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.text.font.FontFamily
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.cards.*
import io.orbitd.android.core.protocol.Wire
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** The owner's exception card as the conversation draws it (A08-17; iOS `OwnerItemCardView`): what has to happen next first, who is on
 * it, each door with its line and in its weight, Review only beside its merge card, the Check row's faces and log, the owner's own
 * ending with the draft it keeps, the pause, and a card whose item went. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h891dp")
class ExceptionCardViewTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val pressed = mutableListOf<Pair<CardVerb, CardInput>>()
    private val opened = mutableListOf<String>()
    private val reviewed = mutableListOf<String>()
    private val key = "item:01a0bb0b-b3fb-744c-b9a6-2fd68b4420b4"

    private fun row(kind: String, actions: List<String>, promotionId: String? = null, taskId: String? = "t1", sessionId: String? = "s9",
        requiredAction: String? = null, handledBy: List<String> = emptyList(), facts: JsonElement = JsonNull, fuseEpisodeId: String? = null,
        reason: String = "ESCALATED") = buildJsonObject {
        put("itemId", "01a0bb0b-b3fb-744c-b9a6-2fd68b4420b4"); put("kind", kind); put("title", "Checks failed on the combined tree")
        put("detailLine", "the merge check exited 1"); put("assignee", "OWNER"); put("assigneeReason", reason)
        put("waitingSince", "2026-09-19T19:01:41.497Z"); put("escalatedAt", if (reason == "ESCALATED") "2026-09-19T21:02:23.903Z" else null)
        put("taskId", taskId); put("sessionId", sessionId); put("promotionId", promotionId); put("fuseEpisodeId", fuseEpisodeId)
        putJsonObject("delivery") { put("state", "NOT_REQUIRED"); put("sessionId", JsonNull); put("at", JsonNull) }
        putJsonArray("actions") { actions.forEach { add(it) } }
        requiredAction?.let { put("requiredAction", it) }
        if (handledBy.isNotEmpty()) putJsonArray("handledBy") { handledBy.forEach { addJsonObject { put("taskId", "f"); put("title", it); put("state", "OPEN") } } }
        put("question", JsonNull); put("facts", facts)
    }
    private fun card(row: JsonObject) = CardCatalog.project("s1", "p1", mapOf("project" to buildJsonObject { put("id", "p1") },
        "openItems" to buildJsonObject { putJsonArray("needsYou") { add(row) }; putJsonArray("withCoordinator") {} })).single()

    private fun show(card: InteractionCard, mergeCard: String? = null) {
        compose.runOnUiThread { compose.activity.setContent { MaterialTheme { Column(Modifier.verticalScroll(rememberScrollState())) {
            ExceptionCard(card, fresh = true, result = CardActionState(), mergeCard = mergeCard, open = { opened += it }, discuss = null,
                review = { reviewed += it }) { verb, input -> pressed += verb to input }
        } } } }
        compose.waitForIdle()
    }
    private fun top(tag: String) = compose.onNodeWithTag(tag, useUnmergedTree = true).fetchSemanticsNode().boundsInRoot.top

    private val check = Wire.json.parseToJsonElement("""{"task":null,"targetRef":"project/bg-jobs","targetSha":"b70a4461c2d3","files":[],"nothingLanded":false,
        "check":{"command":"cd src/runner-go && go test ./...","exitCode":1,"timedOut":false,"durationMs":340000,
          "outputTail":"--- FAIL: TestScheduleWakeup\n    wake_test.go:88: wake not delivered\nFAIL"},"branchUnchanged":true,"errorCode":null,"failure":null}""")

    @Test fun itOpensWithWhatHasToHappenNextThenTheDoorsEachWithItsLine() {
        val candidate = card(row("INTEGRATION_CHECK_FAILED", listOf("ASK_COORDINATOR_AGAIN", "RETRY", "REVIEW"), promotionId = "pr1", taskId = null,
            sessionId = null, requiredAction = "Nothing on the project branch reaches main until this check passes.", handledBy = listOf("Fix the branch"),
            facts = check))
        show(candidate, mergeCard = "pr1")
        compose.onNodeWithTag("$key:title", useUnmergedTree = true).assertTextEquals("Escalated to you")
        compose.onNodeWithTag("$key:required", useUnmergedTree = true).assertTextEquals("Nothing on the project branch reaches main until this check passes.")
        compose.onNodeWithTag("$key:handled-by", useUnmergedTree = true).assertTextEquals("The coordinator is fixing this in Fix the branch.")
        assertTrue("what has to happen next comes first", top("$key:required") < top("$key:handled-by"))
        assertTrue(top("$key:handled-by") < top("$key:RETURN_COORDINATOR"))
        // The owner's card leads with the way back to the coordinator, then the re-check, then the quiet Review.
        assertTrue(top("$key:RETURN_COORDINATOR") < top("$key:RERUN_CHECK")); assertTrue(top("$key:RERUN_CHECK") < top("$key:REVIEW"))
        compose.onNodeWithTag("$key:RERUN_CHECK").assertTextEquals(ExceptionCards.rerunCheck)
        compose.onNodeWithTag("$key:RERUN_CHECK:consequence", useUnmergedTree = true).assertTextEquals(ExceptionCards.promotionRetryConsequence)
        compose.onNodeWithTag("$key:RETURN_COORDINATOR:consequence", useUnmergedTree = true)
            .assertTextEquals("It goes back to the coordinator with a fresh escalation clock.")
        compose.onNodeWithTag("$key:REVIEW:consequence", useUnmergedTree = true).assertTextEquals("Open the current merge card.")
        compose.onNodeWithTag("$key:MARK_HANDLED:consequence", useUnmergedTree = true).assertTextEquals(ExceptionCards.markHandledConsequence)
        assertTrue("the ending comes last", top("$key:REVIEW") < top("$key:MARK_HANDLED"))
        assertTrue("the doors come before the facts", top("$key:MARK_HANDLED") < top("$key:fact:Check"))
        // The Check row: its command mono, its verdict red, its log hung under it and before the next fact.
        val text = compose.onNode(hasText("cd src/runner-go", substring = true), useUnmergedTree = true).fetchSemanticsNode().config[SemanticsProperties.Text].single()
        val mono = text.spanStyles.single { it.item.fontFamily == FontFamily.Monospace }
        assertEquals("cd src/runner-go && go test ./...", text.text.substring(mono.start, mono.end))
        val bad = text.spanStyles.single { it.item.color != Color.Unspecified }
        assertEquals("exit 1", text.text.substring(bad.start, bad.end))
        assertTrue(top("$key:fact:Check") < top("$key:log")); assertTrue(top("$key:log") < top("$key:fact:Branch"))
        compose.onNodeWithTag("$key:owner", useUnmergedTree = true).assertExists()
        compose.onNodeWithTag("$key:RERUN_CHECK").performClick()
        assertEquals(listOf(CardVerb.RERUN_CHECK), pressed.map { it.first })
        compose.onNodeWithTag("$key:REVIEW").performClick()
        assertEquals(listOf("pr1"), reviewed)
    }

    @Test fun reviewIsDrawnOnlyWhereTheMergeCardIs() {
        show(card(row("INTEGRATION_ERROR", listOf("ASK_COORDINATOR_AGAIN", "REVIEW"), promotionId = "pr1")), mergeCard = null)
        compose.onNodeWithTag("$key:RETURN_COORDINATOR").assertExists()
        compose.onNodeWithTag("$key:REVIEW").assertDoesNotExist()
        compose.onNodeWithTag("$key:REVIEW:consequence", useUnmergedTree = true).assertDoesNotExist()
    }

    @Test fun aFailedTaskRunsAgainWithItsOwnPressAndCancelAsksFirst() {
        show(card(row("TASK_FAILED", listOf("ASK_COORDINATOR_AGAIN", "OPEN_TASK_SESSION", "RETRY", "CANCEL_TASK"), reason = "DEFAULT")))
        compose.onNodeWithTag("$key:RETRY_TASK:consequence", useUnmergedTree = true).assertTextEquals(ExceptionCards.taskRunAgainConsequence)
        compose.onNodeWithTag("$key:RETRY_TASK").assertTextEquals("Retry").performClick()
        val (verb, input) = pressed.single()
        assertEquals(CardVerb.RETRY_TASK, verb); assertFalse(input.triggerId.isNullOrBlank())
        compose.onNodeWithTag("$key:OPEN_TASK_SESSION").performClick()
        assertEquals(listOf("orbit-session:s9"), opened)
        compose.onNodeWithTag("$key:CANCEL_TASK").performClick()
        assertEquals("cancelling asks first", 1, pressed.size)
        compose.onNodeWithTag("confirm:CANCEL_TASK").performClick()
        assertEquals(CardVerb.CANCEL_TASK, pressed.last().first)
    }

    @Test fun theOwnersEndingKeepsItsDraftAndWaitsForAReason() {
        show(card(row("INTEGRATION_CONFLICT", listOf("ASK_COORDINATOR_AGAIN", "OPEN_TASK_SESSION"))))
        compose.onNodeWithTag("$key:MARK_HANDLED").performClick()
        compose.onNodeWithText(ExceptionCards.markHandledTitle).assertExists()
        compose.onNodeWithText(ExceptionCards.markHandledBody).assertExists()
        compose.onNodeWithTag("$key:mark-handled-confirm").assertIsNotEnabled()
        compose.onNodeWithTag("$key:reason").performTextInput("landed by hand")
        compose.onNodeWithTag("$key:mark-handled-confirm").assertIsEnabled()
        compose.onNodeWithTag("$key:mark-handled-back").performClick()
        compose.onNodeWithTag("$key:mark-handled-panel").assertDoesNotExist()
        compose.onNodeWithTag("$key:MARK_HANDLED").performClick()
        compose.onNodeWithTag("$key:reason").assertTextContains("landed by hand")
        compose.onNodeWithTag("$key:reason").performTextReplacement("x".repeat(2_100))
        compose.waitForIdle()
        val held = compose.onNodeWithTag("$key:reason").fetchSemanticsNode().config[SemanticsProperties.EditableText].text
        assertEquals("the field stops where the door does", 2_000, held.length)
        compose.onNodeWithTag("$key:mark-handled-confirm").performClick()
        assertEquals(CardVerb.MARK_HANDLED, pressed.single().first)
        assertEquals(2_000, pressed.single().second.text.length)
    }

    @Test fun aPauseIsItsOwnCardWithOneDoor() {
        show(card(row("FUSE_PAUSED", listOf("RESUME"), taskId = null, sessionId = null, fuseEpisodeId = "ep1", reason = "DEFAULT")))
        compose.onNodeWithTag("$key:title", useUnmergedTree = true).assertTextEquals("Paused")
        compose.onNodeWithTag("$key:RESUME:consequence", useUnmergedTree = true).assertTextEquals("The coordinator resumes and held work can continue.")
        compose.onNodeWithTag("$key:MARK_HANDLED").assertDoesNotExist()
        compose.onNodeWithTag("$key:RESUME").performClick()
        assertEquals(listOf(CardVerb.RESUME), pressed.map { it.first })
    }

    @Test fun aCardWhoseItemWentSaysSoAndOffersNothing() {
        show(SessionCardsModel.stale(card(row("TASK_FAILED", listOf("RETRY")))))
        compose.onNodeWithTag("$key:gone", useUnmergedTree = true).assertTextEquals(ExceptionCards.gone)
        compose.onNodeWithTag("$key:RETRY_TASK").assertDoesNotExist()
        compose.onNodeWithTag("$key:next").assertDoesNotExist()
    }
}
