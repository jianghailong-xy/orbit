package io.orbitd.android.cards

import android.graphics.Bitmap
import android.graphics.Canvas
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.cards.CoordinatorDeliveryLine
import io.orbitd.android.core.cards.transcriptCards
import io.orbitd.android.core.realtime.RunEvent
import io.orbitd.android.reader.QuestionCapsule
import io.orbitd.android.reader.TranscriptRow
import io.orbitd.android.ui.OrbitTheme
import java.io.File
import java.time.Instant
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import org.robolectric.shadows.ShadowDialog

/**
 * NATIVE frames of a fact told to the coordinator on a phone (docs/mocks/coordinator-delivery-line/ 03): the line as the reader
 * draws it — the sentence on its first row, "Sent to the coordinator · time" on its second — and the sticky header's capsule once the
 * line is scrolled past, `↑ From Orbit` and the sentence; and the owner's answer to a criteria proposal told to a task's run, which is
 * not the coordinator, with what it opens to. Each is drawn by the production composable and written under
 * `src/android/build/evidence/coordinator-delivery-android/` beside its semantics tree; the rows' bounds are asserted, not eyeballed.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h891dp")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class CoordinatorDeliveryShotsTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    private val title = "Wiki model queue: one claim can take more requests than the concurrency room"
    private val sentence = "Evidence revision 1 submitted: $title"
    private val event = RunEvent("user", 9, buildJsonObject {
        put("text", "From Orbit · project “Runner link v1” has a revision of completion evidence for you to decide\n\n" +
            "Task “$title” (34nmQgDgyywHNIUtjb9TD) submitted revision 1 of its completion evidence.")
        putJsonObject("coordinatorDelivery") {
            put("kind", "EVIDENCE_SUBMITTED")
            putJsonObject("task") { put("id", "34nmQgDgyywHNIUtjb9TD"); put("title", title) }
            put("revision", 1); put("count", JsonNull); put("deliveredAt", Instant.now().minusSeconds(3600).toString())
        }
    }, "turn-delivery")

    private val output: File by lazy {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
            .first { File(it, "src/android/settings.gradle.kts").isFile }
        File(root, "src/android/build/evidence/coordinator-delivery-android").also { it.mkdirs() }
    }

    private fun show(content: @Composable () -> Unit) {
        compose.runOnUiThread { compose.activity.setContent { OrbitTheme(darkTheme = false) {
            Surface(color = MaterialTheme.colorScheme.background) { content() }
        } } }
        compose.waitForIdle()
    }

    private fun shot(name: String) {
        compose.waitForIdle()
        File(output, "$name-semantics.txt").writeText(compose.onRoot(useUnmergedTree = true).printToString())
        val view = compose.activity.window.decorView
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }

    /** The line at a phone's width: two rows, the sentence first and when it was sent under it, the sentence cut short, the time not. */
    @Test fun thePhoneLine() {
        show { Column(Modifier.fillMaxWidth().padding(16.dp)) { TranscriptCardView(transcriptCards(event).single(), {}, event) } }
        val words = compose.onNodeWithTag("record:9:coordinatorDelivery:sentence", useUnmergedTree = true)
        val time = compose.onNodeWithTag("record:9:coordinatorDelivery:sent", useUnmergedTree = true)
        words.assertTextEquals(sentence)
        time.assertTextEquals(CoordinatorDeliveryLine.sent(CoordinatorDeliveryLine.parse(event.payload.jsonObject["coordinatorDelivery"]!!.jsonObject)!!))
        val first = words.fetchSemanticsNode().boundsInRoot
        val second = time.fetchSemanticsNode().boundsInRoot
        assertTrue("the time is not on the row under the sentence: $first / $second", second.top >= first.bottom - 1f)
        assertEquals("both rows start at the same edge", first.left, second.left, 1f)
        compose.onAllNodesWithText("Put back in the composer", useUnmergedTree = true).assertCountEquals(0)
        shot("phone-line")
    }

    /**
     * The owner's answer to a criteria proposal a task's run filed, told to that run — the card's `toCoordinator` false: the line says
     * "Sent to this session · time", and pressing it opens "What this session was told" over the words. Nothing says the coordinator.
     */
    @Test fun theTaskRunsReply() {
        val reply = RunEvent("user", 11, buildJsonObject {
            put("text", "From Orbit · criteria decision\n\nYour criteria proposal 34pX0YF3mJmoTBvNxc8Kt on project “Runner link v1” " +
                "(34nmPkyh9pd8tVm1fCv2Q) was refused by the account owner at 2026-10-31T11:30:00.000Z. Nothing was applied: " +
                "criterion 2 stays at revision 1.")
            putJsonObject("coordinatorDelivery") {
                put("kind", "CRITERIA_REJECTED"); put("task", JsonNull); put("revision", JsonNull); put("count", JsonNull)
                put("deliveredAt", Instant.now().minusSeconds(3600).toString()); put("toCoordinator", false)
            }
        }, "turn-reply")
        show { Column(Modifier.fillMaxWidth().padding(16.dp)) { TranscriptCardView(transcriptCards(reply).single(), {}, reply) } }
        compose.onNodeWithTag("record:11:coordinatorDelivery:sentence", useUnmergedTree = true).assertTextEquals("Criteria proposal rejected")
        val sent = CoordinatorDeliveryLine.sent(CoordinatorDeliveryLine.parse(reply.payload.jsonObject["coordinatorDelivery"]!!.jsonObject)!!)
        assertTrue(sent, sent.startsWith("${CoordinatorDeliveryLine.sentToThisSession} · "))
        compose.onNodeWithTag("record:11:coordinatorDelivery:sent", useUnmergedTree = true).assertTextEquals(sent)
        compose.onAllNodesWithText("coordinator", substring = true, useUnmergedTree = true).assertCountEquals(0)
        shot("run-reply-line")

        compose.onNodeWithText("Criteria proposal rejected", useUnmergedTree = true).performClick()
        compose.waitForIdle()
        compose.onNodeWithText(CoordinatorDeliveryLine.toldThisSession, useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithText("was refused by the account owner", substring = true, useUnmergedTree = true).assertIsDisplayed()
        compose.onAllNodesWithText("coordinator", substring = true, useUnmergedTree = true).assertCountEquals(0)
        dialogShot("run-reply-told")
    }

    /** The dialog the line opened, which is a window of its own: its frame and every root's semantics. */
    private fun dialogShot(name: String) {
        compose.waitForIdle()
        File(output, "$name-semantics.txt").writeText(compose.onAllNodes(isRoot(), useUnmergedTree = true).printToString(maxDepth = Int.MAX_VALUE))
        val view = ShadowDialog.getLatestDialog()!!.window!!.decorView
        val bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888)
        view.draw(Canvas(bitmap))
        File(output, "$name.png").outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
    }

    /** Scrolled past, the reader's top bar names the line in its capsule: `↑ From Orbit`, then the line's own sentence. */
    @Test fun theStickyHeader() {
        show { Column(Modifier.fillMaxWidth().padding(16.dp)) { QuestionCapsule(TranscriptRow(event)) {} } }
        compose.onNodeWithText("↑ From Orbit", useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithText(sentence, useUnmergedTree = true).assertIsDisplayed()
        compose.onAllNodesWithText("Your question", substring = true, useUnmergedTree = true).assertCountEquals(0)
        shot("sticky-header")
    }
}
