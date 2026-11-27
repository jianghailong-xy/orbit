package io.orbitd.android.cards

import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.cards.OpenItemDeliveryCopy
import io.orbitd.android.core.cards.transcriptCards
import io.orbitd.android.core.realtime.RunEvent
import kotlinx.serialization.json.*
import java.time.Instant
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** An open-item delivery's card in the reader (iOS `OpenItemDeliveryCardView`, web `OpenItemDeliveryCard.tsx`, board card-ui-polish ②):
 * no "The coordinator can:" chips but Go to the item card ↑, which scrolls to the item's own card or says it is not in this conversation;
 * the foot says when it was sent; the item's id lives in the disclosure; the conflict headline names the branch; and the ways into the
 * record — the task, the session whose failure opened the item, and the landing it belongs to — each only where the payload names it. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h891dp")
class TranscriptDeliveryCardTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val opened = mutableListOf<String>()
    private val revealed = mutableListOf<String>()
    private val key = "record:3:openItemDelivery"
    private val itemId = "01a0bb0b-b3fb-744c-b9a6-2fd68b4420b4"
    private val taskId = "01a03f58-40bd-76ac-85c1-d9c6b29f8ca9"
    private val sessionId = "489fc485-949c-533a-9b56-7712a68762ef"

    private fun delivery(task: JsonObject? = buildJsonObject { put("id", taskId); put("title", "Wire the page"); put("sessionId", sessionId) },
        landing: String? = "L1", kind: String = "INTEGRATION_CHECK_FAILED", targetRef: String? = null) = buildJsonObject {
        put("itemId", itemId); put("kind", kind); put("title", "Checks failed on the combined tree")
        task?.let { put("task", it) }
        putJsonArray("files") {}
        targetRef?.let { put("targetRef", it) }
        putJsonArray("actions") { add("RETRY"); add("CANCEL_TASK") }
        landing?.let { put("landingSessionId", it) }
    }

    private fun show(card: JsonObject, reveal: ((String) -> Boolean)? = null, ts: String? = null) {
        val event = RunEvent("user", 3, buildJsonObject { put("text", "From Orbit · project item delivered. Call open_item_resolve."); put("openItemDelivery", card) },
            "turn-1", ts = ts)
        compose.runOnUiThread { compose.activity.setContent { MaterialTheme { CompositionLocalProvider(LocalRevealItemCard provides reveal) {
            TranscriptCardView(transcriptCards(event).single(), { opened += it }, event)
        } } } }
        compose.waitForIdle()
    }

    @Test fun theDeliveryCardNamesTheTaskTheFailedSessionAndItsLanding() {
        show(delivery())
        compose.onNodeWithText(OpenItemDeliveryCopy.openTask).assertExists().performClick()
        compose.onNodeWithText(OpenItemDeliveryCopy.openSession).assertExists().performClick()
        compose.onNodeWithText(OpenItemDeliveryCopy.openLanding).assertExists().performClick()
        assertEquals(listOf("orbit-task:$taskId", "orbit-session:$sessionId", "orbit-session:L1"), opened)
    }

    @Test fun aPayloadAnOlderServerRecordedNamesNeitherLink() {
        show(delivery(task = buildJsonObject { put("id", taskId); put("title", "Wire the page") }, landing = null))
        compose.onAllNodesWithText(OpenItemDeliveryCopy.openSession, useUnmergedTree = true).assertCountEquals(0)
        compose.onAllNodesWithText(OpenItemDeliveryCopy.openLanding, useUnmergedTree = true).assertCountEquals(0)
    }

    /** Board ②: no chips, but the way to the item's own card; the conversation scrolls to it. */
    @Test fun goToTheItemCardScrollsToItAndNamesNoDoors() {
        show(delivery(), reveal = { revealed += it; true })
        compose.onAllNodes(hasText("The coordinator can:", substring = true), useUnmergedTree = true).assertCountEquals(0)
        compose.onAllNodes(hasText("Retry the task") or hasText("Cancel the task"), useUnmergedTree = true).assertCountEquals(0)
        compose.onNodeWithText(OpenItemDeliveryCopy.goToItemCard).performClick()
        compose.waitForIdle()
        assertEquals(listOf(itemId), revealed)
        compose.onNodeWithText(OpenItemDeliveryCopy.goToItemCard).assertExists()
        compose.onAllNodesWithText(OpenItemDeliveryCopy.itemCardNotHere).assertCountEquals(0)
    }

    /** A conversation that holds no card for the item says so in place of the link. */
    @Test fun withNoItemCardHereTheLinkSaysSo() {
        show(delivery(), reveal = { false })
        compose.onNodeWithText(OpenItemDeliveryCopy.goToItemCard).performClick()
        compose.waitForIdle()
        compose.onNodeWithText(OpenItemDeliveryCopy.itemCardNotHere).assertExists()
        compose.onAllNodesWithText(OpenItemDeliveryCopy.goToItemCard).assertCountEquals(0)
    }

    /** The foot says when it was sent; the id, the agent's own handle, is inside the disclosure with the words it read. */
    @Test fun theFootSaysWhenItWasSentAndTheIdIsInTheDisclosure() {
        show(delivery(), ts = Instant.now().minusSeconds(150).toString())
        compose.onNodeWithTag("$key:foot", useUnmergedTree = true).assertTextEquals("Sent to the coordinator · 2m ago")
        compose.onAllNodes(hasText("Item ", substring = true), useUnmergedTree = true).assertCountEquals(0)
        compose.onAllNodes(hasText("a notification, not an interruption", substring = true), useUnmergedTree = true).assertCountEquals(0)
        compose.onNodeWithText(OpenItemDeliveryCopy.rawSummary).performClick()
        compose.waitForIdle()
        compose.onNodeWithTag("$key:item-id", useUnmergedTree = true).assertTextEquals("Item ${io.orbitd.android.navigation.ObjectId.toPublic(itemId)}")
        compose.onNodeWithTag("$key:raw-text", useUnmergedTree = true).assertTextEquals("From Orbit · project item delivered. Call open_item_resolve.")
    }

    /** The conflict says the branch by its name, and leaves the agent's "will not retry" half in the disclosure. */
    @Test fun theConflictHeadlineNamesTheBranch() {
        show(delivery(kind = "INTEGRATION_CONFLICT", targetRef = "refs/heads/main"))
        compose.onNodeWithTag("$key:headline", useUnmergedTree = true).assertTextEquals("git refused the merge into main; main did not move.")
        compose.onNodeWithTag("$key:kind", useUnmergedTree = true).assertTextEquals("Merge conflict")
        assertEquals("git refused the merge; the target branch did not move.",
            OpenItemDeliveryCopy.headline(delivery(kind = "INTEGRATION_CONFLICT")))
    }

    private val root = generateSequence(java.io.File(System.getProperty("user.dir"))) { it.parentFile }
        .first { java.io.File(it, "src/macos/OrbitKit/Sources/OrbitKit").isDirectory }

    /** Every word is OrbitKit's (`OpenItemDeliveryCard`), byte for byte, and the board's new ones are the web's own constants. */
    @Test fun theWordsAreTheSwiftsAndTheWebs() {
        val swift = java.io.File(root, "src/macos/OrbitKit/Sources/OrbitKit/Transcript/OpenItemDelivery.swift").readText()
        listOf(OpenItemDeliveryCopy.openSession, OpenItemDeliveryCopy.openLanding, OpenItemDeliveryCopy.openTask, OpenItemDeliveryCopy.header,
            OpenItemDeliveryCopy.goToItemCard, OpenItemDeliveryCopy.itemCardNotHere, OpenItemDeliveryCopy.sentToCoordinator,
            OpenItemDeliveryCopy.undelivered, OpenItemDeliveryCopy.rawSummary, "Merge conflict", "Checks failed", "Integration error", "Task failed",
            "Merge approval", "Question", "Project paused", "The acceptance command disagreed with what the task declared", "A turn of the run failed",
            "The runner finished the run as failed", "The run stopped on an API or sign-in error and was reaped",
            "Its runner went offline and the attempt was taken back", "Its runtime never started and the attempt was taken back",
            "Somebody filed it as failed", "The task failed", "Show fewer files", "git refused the merge; the target branch did not move.",
        ).forEach { assertTrue("OpenItemDelivery.swift no longer says \"$it\"", swift.contains("\"$it\"")) }
        listOf("git refused the merge into \\(branch); \\(branch) did not move.", "\"\\(sentToCoordinator) · \\(relative)\"",
            "\"Item \\(PublicID.toPublic(card.itemId))\"", "public static let filesShown = ${OpenItemDeliveryCopy.filesShown}",
        ).forEach { assertTrue("OpenItemDelivery.swift no longer says $it", swift.contains(it)) }
        // The chips and their sentences are gone from OrbitKit; this end draws none either.
        listOf("The coordinator can:", "a notification, not an interruption", "The platform will not retry it by itself.")
            .forEach { assertFalse("OpenItemDelivery.swift says \"$it\" again", swift.contains(it)) }
        val web = java.io.File(root, "src/web/src/components/OpenItemDeliveryCard.tsx").readText()
        assertTrue(web.contains("export const GO_TO_ITEM_CARD = '${OpenItemDeliveryCopy.goToItemCard}';"))
        assertTrue(web.contains("export const ITEM_CARD_NOT_HERE = '${OpenItemDeliveryCopy.itemCardNotHere}';"))
        assertTrue(web.contains("export const SENT_TO_COORDINATOR = '${OpenItemDeliveryCopy.sentToCoordinator}';"))
        assertTrue(web.contains("`git refused the merge into \${branch}; \${branch} did not move.`"))
    }
}
