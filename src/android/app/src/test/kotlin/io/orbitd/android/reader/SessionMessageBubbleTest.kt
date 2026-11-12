package io.orbitd.android.reader

import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.unit.dp
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.cards.TranscriptCardView
import io.orbitd.android.core.cards.transcriptCards
import io.orbitd.android.core.realtime.RunEvent
import java.time.Instant
import kotlinx.serialization.json.*
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Another session's message as a bubble on the left (docs/mocks/session-message-bubble, owner 2026-11-12; web `SessionMessageCard`): who
 * sent it on a grey line above, the words in a bubble that hugs them up to 720 dp, and one grey foot line under it. "Sent by another Orbit
 * session, not by you" is only read out. Orbit's other cards on the left stop at 720 dp too.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w1200dp-h891dp")
class SessionMessageBubbleTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val opened = mutableListOf<String>()

    private fun message(text: String, note: String? = null, task: String? = "task-7", request: String? = null) = RunEvent("user", 3, buildJsonObject {
        put("text", text)
        note?.let { put("controlPlaneNote", it) }
        putJsonObject("sessionMessage") {
            put("fromSessionId", "s-2"); put("fromTitle", "Task: Record the heartbeat fix"); put("fromAgentName", "orbit-prod")
            task?.let { put("fromTaskId", it) }
            request?.let { put("requestId", it) }
        }
    }, "turn-1", ts = Instant.now().minusSeconds(5).toString())

    private fun show(event: RunEvent) {
        compose.runOnUiThread { compose.activity.setContent { MaterialTheme { Column(Modifier.fillMaxWidth()) {
            transcriptCards(event).forEach { TranscriptCardView(it, { opened += it }, event) }
        } } } }
        compose.waitForIdle()
    }

    @Test fun theSenderIsOneGreyLineAboveTheBubbleAndOpensTheirSession() {
        show(message("Did you restart the runner by hand?"))
        compose.onNodeWithText("From ", useUnmergedTree = true).assertExists()
        compose.onNodeWithText(" · orbit-prod", useUnmergedTree = true).assertExists()
        compose.onNodeWithTag("session-message:from").assertTextEquals("Task: Record the heartbeat fix")
            .performSemanticsAction(SemanticsActions.OnClick)
        assertEquals(listOf("orbit-session:s-2"), opened)
        // Gone from the visible text, still read out over the bubble.
        compose.onAllNodesWithText(SessionMessageCopy.NOT_YOU, substring = true, useUnmergedTree = true).assertCountEquals(0)
        compose.onNodeWithContentDescription(SessionMessageCopy.NOT_YOU).assertExists()
        compose.onAllNodesWithText("Open sender session", useUnmergedTree = true).assertCountEquals(0)
    }

    @Test fun theFootIsOneLineOfTimeTaskRequestAndAttachment() {
        show(message("Did you restart the runner by hand?", note = "<orbit-session-message from-session=\"s-2\">\nfrom another session\n</orbit-session-message>",
            request = "req-1"))
        compose.onNodeWithText("just now · ", useUnmergedTree = true).assertExists()
        compose.onNodeWithText("Its task ↗ · ", useUnmergedTree = true).performSemanticsAction(SemanticsActions.OnClick)
        assertEquals(listOf("orbit-task:task-7"), opened)
        compose.onNodeWithText("Asked for a reply · ", useUnmergedTree = true).assertExists()
        compose.onNodeWithText("⊕ Orbit attached: session message", useUnmergedTree = true).assertExists()
            .performSemanticsAction(SemanticsActions.OnClick)
        compose.onNodeWithText("from another session", substring = true, useUnmergedTree = true).assertExists()
    }

    @Test fun aMessageWithNoTaskOrRequestEndsItsFootAtTheTime() {
        show(message("Short.", task = null))
        compose.onNodeWithText("just now", useUnmergedTree = true).assertExists()
        compose.onAllNodesWithText("Its task ↗", substring = true, useUnmergedTree = true).assertCountEquals(0)
    }

    @Test fun theBubbleHugsShortWordsAndStopsAt720() {
        show(message("Short."))
        val short = compose.onNodeWithTag("session-message:bubble").fetchSemanticsNode().size.width
        show(message((1..40).joinToString(" ") { "word$it of a long line that runs past the bubble's widest" }))
        val long = compose.onNodeWithTag("session-message:bubble").fetchSemanticsNode().size.width
        val max = with(compose.density) { 720.dp.roundToPx() }
        assertTrue("short words hug: $short", short < max / 2)
        assertTrue("long words stop at 720 dp: $long", long in (max - 2)..max)
    }

    @Test fun aLongMessageFoldsPastSixLines() {
        show(message((1..10).joinToString("\n\n") { "Line $it of the plan." }))
        compose.onNodeWithTag("session-message:clamped", useUnmergedTree = true).assertExists()
        show(message((1..3).joinToString("\n\n") { "Line $it of the plan." }))
        compose.onNodeWithTag("session-message:whole", useUnmergedTree = true).assertExists()
    }

    @Test fun orbitsOtherCardsOnTheLeftStopAt720() {
        val event = RunEvent("user", 5, buildJsonObject { put("text", "Task started"); putJsonObject("taskStart") { put("taskId", "t1"); put("title", "Wire the checks") } })
        compose.runOnUiThread { compose.activity.setContent { MaterialTheme { Row(Modifier.fillMaxWidth()) {
            Box(Modifier.testTag("host")) { TranscriptCardView(transcriptCards(event).single(), {}, event) }
        } } } }
        compose.waitForIdle()
        val width = compose.onNodeWithTag("host").fetchSemanticsNode().size.width
        assertEquals(with(compose.density) { 720.dp.roundToPx() }, width)
    }
}
