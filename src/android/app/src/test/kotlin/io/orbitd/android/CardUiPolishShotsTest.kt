package io.orbitd.android

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import io.orbitd.android.cards.ExceptionCard
import io.orbitd.android.cards.LocalRevealItemCard
import io.orbitd.android.cards.QuestionRecordCard
import io.orbitd.android.cards.TranscriptCardView
import io.orbitd.android.core.cards.CardActionState
import io.orbitd.android.core.cards.CardCatalog
import io.orbitd.android.core.cards.CoordinatorQuestions
import io.orbitd.android.core.cards.OpenItemDeliveryCopy
import io.orbitd.android.core.cards.transcriptCards
import io.orbitd.android.core.realtime.RunEvent
import io.orbitd.android.ui.OrbitTheme
import java.io.File
import java.time.Instant
import kotlinx.serialization.json.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Board card-ui-polish on Android, one frame per changed state, drawn by the production composables (NATIVE graphics, 3x density) and
 * written under `src/android/build/evidence/card-ui-polish-android/` beside each frame's semantics tree: the item card while a repair
 * task is live and after it ended (①), the exception delivery card with Go to the item card and its new foot, the same card in a
 * conversation without the item card and with its disclosure open (②), and an answered question folded and unfolded in place (③).
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h1200dp-xxhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class CardUiPolishShotsTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    private val output: File by lazy {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
            .first { File(it, "src/android/settings.gradle.kts").isFile }
        File(root, "src/android/build/evidence/card-ui-polish-android").also { it.mkdirs() }
    }

    private fun show(content: @Composable () -> Unit) {
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme(darkTheme = false) {
            Surface(color = MaterialTheme.colorScheme.background) {
                Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp)) { content() }
            }
        } } }
        compose.waitForIdle()
    }

    private fun shot(name: String) {
        compose.mainClock.advanceTimeBy(500)
        compose.waitForIdle()
        File(output, "$name-semantics.txt").writeText(compose.onAllNodes(isRoot()).onFirst().printToString(maxDepth = Int.MAX_VALUE))
        val view = compose.activity.window.decorView
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }

    /** The web test's item (`ProjectProgressStatus.test.tsx`, "a coordinator item with a live repair"), as the owner's own. */
    private fun item(repairState: String) = buildJsonObject {
        put("itemId", "01a0bb0b-b3fb-744c-b9a6-2fd68b4420b4"); put("kind", "INTEGRATION_CONFLICT")
        put("title", "Merge conflict: Regenerate the API reference"); put("detailLine", "1 file conflicts with main")
        put("assignee", "OWNER"); put("assigneeReason", "DEFAULT"); put("waitingSince", Instant.now().minusSeconds(14 * 60).toString())
        put("escalatedAt", JsonNull); put("taskId", "01a03f58-40bd-76ac-85c1-d9c6b29f8ca9"); put("sessionId", JsonNull)
        put("promotionId", "pr1"); put("fuseEpisodeId", JsonNull); put("landingSessionId", "34Y7Utvsd47A14DjMzIzE"); put("integrationJobId", JsonNull)
        putJsonObject("delivery") { put("state", "NOT_REQUIRED"); put("sessionId", JsonNull); put("at", JsonNull) }
        putJsonArray("actions") { add("REVIEW"); add("OPEN_LANDING") }
        put("primaryAction", "REVIEW")
        put("requiredAction", "A repair task is already handling this item — let it finish or open the task to see what it needs.")
        putJsonArray("handledBy") { addJsonObject {
            put("taskId", "01a0bb0b-b3fb-744c-b9a6-2fd68b4420f0"); put("title", "regenerate api-reference.md"); put("state", repairState) } }
        put("question", JsonNull); put("lease", JsonNull)
        putJsonObject("facts") {
            putJsonObject("task") { put("id", "01a03f58-40bd-76ac-85c1-d9c6b29f8ca9"); put("title", "Regenerate the API reference") }
            put("targetRef", "refs/heads/main"); put("targetSha", "928ed7e0000"); putJsonArray("files") { add("docs/api-reference.md") }
            put("nothingLanded", true); put("check", JsonNull); put("branchUnchanged", false); put("errorCode", JsonNull); put("failure", JsonNull)
        }
    }

    private fun itemCard(repairState: String) {
        val card = CardCatalog.project("s1", "p1", mapOf("project" to buildJsonObject { put("id", "p1") },
            "openItems" to buildJsonObject { putJsonArray("needsYou") { add(item(repairState)) } })).single()
        show { ExceptionCard(card, fresh = true, result = CardActionState(), mergeCard = "pr1", open = {}, discuss = {}, review = {}) { _, _ -> } }
    }

    /** ① A live repair: the Fixing tag, one linked line, quiet links under the facts, and the Into row naming main. */
    @Test fun a1ItemCardWithALiveRepair() {
        itemCard("IN_PROGRESS")
        compose.onNodeWithTag("item:01a0bb0b-b3fb-744c-b9a6-2fd68b4420b4:fixing-tag", useUnmergedTree = true).assertExists()
        shot("01-item-card-fixing")
    }

    /** ① The same item once its repair has ended: the card it was before, sentence and weighted doors. */
    @Test fun a2ItemCardAfterTheRepairEnded() {
        itemCard("DONE")
        compose.onNodeWithTag("item:01a0bb0b-b3fb-744c-b9a6-2fd68b4420b4:required", useUnmergedTree = true).assertExists()
        shot("02-item-card-repair-ended")
    }

    private fun delivery(reveal: (String) -> Boolean) {
        val payload = buildJsonObject {
            put("itemId", "01a0bb0b-b3fb-744c-b9a6-2fd68b4420b4"); put("kind", "INTEGRATION_CONFLICT")
            put("title", "Merge conflict: Regenerate the API reference")
            putJsonObject("task") { put("id", "01a03f58-40bd-76ac-85c1-d9c6b29f8ca9"); put("title", "Regenerate the API reference")
                put("sessionId", "489fc485-949c-533a-9b56-7712a68762ef") }
            putJsonArray("files") { add("docs/api-reference.md") }
            put("targetRef", "refs/heads/main")
            putJsonArray("actions") { add("OPEN_TASK_SESSION"); add("CANCEL_TASK") }
            putJsonObject("landing") { put("receipts", 0); put("state", "NOT_KNOWN"); put("upstream", "main"); put("integration", "main") }
            put("landingSessionId", "34Y7Utvsd47A14DjMzIzE")
        }
        val event = RunEvent("user", 3, buildJsonObject {
            put("text", "From Orbit · project item delivered.\n\nOpen item 01a0bb0b-b3fb-744c-b9a6-2fd68b4420b4 (INTEGRATION_CONFLICT): git refused " +
                "the merge into refs/heads/main; the target branch did not move. The platform will not retry it by itself. Resolve it with " +
                "open_item_resolve or hand it over with open_item_hand_over.")
            put("openItemDelivery", payload)
        }, "turn-1", ts = Instant.now().minusSeconds(180).toString())
        show { CompositionLocalProvider(LocalRevealItemCard provides reveal) { TranscriptCardView(transcriptCards(event).single(), {}, event) } }
    }

    /** ② The delivery: no chips, Go to the item card ↑ with the task, session and landing links, and "Sent to the coordinator · 3m ago". */
    @Test fun b1ExceptionDeliveryCard() {
        delivery { true }
        compose.onNodeWithText(OpenItemDeliveryCopy.goToItemCard).assertExists()
        shot("03-delivery-card")
    }

    /** ② In a conversation that holds no card for the item, the link says so; the disclosure holds the item id and the agent's words. */
    @Test fun b2ExceptionDeliveryCardWithoutItsItemCardAndItsDisclosureOpen() {
        delivery { false }
        compose.onNodeWithText(OpenItemDeliveryCopy.goToItemCard).performClick()
        compose.onNodeWithText(OpenItemDeliveryCopy.rawSummary).performClick()
        compose.onNodeWithText(OpenItemDeliveryCopy.itemCardNotHere).assertExists()
        shot("04-delivery-card-not-here-disclosure-open")
    }

    private val question = buildJsonObject {
        put("question", "The rollback's follow-ups are done:\n\n- maintenance resumed\n- **all three fixes** shipped\n\nApprove reopening the rollout.")
        putJsonArray("options") {
            addJsonObject { put("label", "Reopen now"); put("description", "No special timing.") }
            addJsonObject { put("label", "Switch at the next round") }
        }
        put("recommendedOption", 0)
    }

    private fun answered(initiallyOpen: Boolean) {
        val record = buildJsonObject {
            put("itemId", "item-1"); put("question", question); put("askedAt", "2026-10-09T00:10:00.000Z")
            put("resolution", "ANSWERED"); put("resolvedBy", "USER"); put("resolvedAt", Instant.now().minusSeconds(600).toString())
            putJsonObject("answer") { put("option", 1); put("text", "After 22:00.") }
            put("delivery", buildJsonObject { put("sessionId", "c1"); put("at", Instant.now().minusSeconds(590).toString()) })
            put("withdrawReason", JsonNull)
        }
        val card = CardCatalog.project("s1", "p1", mapOf("project" to buildJsonObject { put("id", "p1") },
            "openItems" to buildJsonObject { putJsonArray("needsYou") {}; putJsonArray("closedQuestions") { add(record) } })).single()
        show { QuestionRecordCard(card, initiallyOpen = initiallyOpen) }
    }

    /** ③ Folded: the record, "View details ›". */
    @Test fun c1AnsweredQuestionFolded() {
        answered(initiallyOpen = false)
        compose.onNodeWithText(CoordinatorQuestions.viewDetails, useUnmergedTree = true).assertExists()
        shot("05-answered-folded")
    }

    /** ③ Unfolded in place by a tap (no sheet): the full record and "Hide details ⌃". */
    @Test fun c2AnsweredQuestionExpandedInPlace() {
        answered(initiallyOpen = false)
        compose.onNodeWithText(CoordinatorQuestions.viewDetails, useUnmergedTree = true).performClick()
        compose.onNodeWithText(CoordinatorQuestions.hideDetails, useUnmergedTree = true).assertExists()
        compose.onAllNodes(isDialog()).assertCountEquals(0)
        shot("06-answered-expanded-in-place")
    }
}
