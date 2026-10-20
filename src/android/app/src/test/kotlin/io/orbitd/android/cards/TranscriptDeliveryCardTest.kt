package io.orbitd.android.cards

import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.cards.OpenItemDeliveryCopy
import io.orbitd.android.core.cards.transcriptCards
import io.orbitd.android.core.realtime.RunEvent
import kotlinx.serialization.json.*
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** An open-item delivery's card in the reader (iOS `OpenItemDeliveryCardView`, board v4 06 b): with the two ways into the record — the
 * session whose failure opened the item, and the landing it belongs to (§2.9 LS6). Either is drawn only where the payload names it. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h891dp")
class TranscriptDeliveryCardTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val opened = mutableListOf<String>()

    private fun delivery(task: JsonObject? = buildJsonObject { put("id", "t1"); put("title", "Wire the page"); put("sessionId", "s-failed") },
        landing: String? = "L1") = buildJsonObject {
        put("itemId", "i1"); put("kind", "INTEGRATION_CHECK_FAILED"); put("title", "Checks failed on the combined tree")
        task?.let { put("task", it) }
        putJsonArray("files") {}
        landing?.let { put("landingSessionId", it) }
    }

    private fun show(card: JsonObject) {
        val event = RunEvent("user", 3, buildJsonObject { put("text", "From Orbit · project item delivered"); put("openItemDelivery", card) }, "turn-1")
        compose.runOnUiThread { compose.activity.setContent { MaterialTheme { TranscriptCardView(transcriptCards(event).single(), { opened += it }, event) } } }
        compose.waitForIdle()
    }

    @Test fun theDeliveryCardNamesTheFailedSessionAndItsLanding() {
        show(delivery())
        assertEquals("Open the failed session ↗", OpenItemDeliveryCopy.openSession)
        assertEquals("Open the landing ↗", OpenItemDeliveryCopy.openLanding)
        compose.onNodeWithText(OpenItemDeliveryCopy.openSession).assertExists().performClick()
        compose.onNodeWithText(OpenItemDeliveryCopy.openLanding).assertExists().performClick()
        assertEquals(listOf("orbit-session:s-failed", "orbit-session:L1"), opened)
    }

    @Test fun aPayloadAnOlderServerRecordedNamesNeitherLink() {
        show(delivery(task = buildJsonObject { put("id", "t1"); put("title", "Wire the page") }, landing = null))
        compose.onAllNodesWithText(OpenItemDeliveryCopy.openSession, useUnmergedTree = true).assertCountEquals(0)
        compose.onAllNodesWithText(OpenItemDeliveryCopy.openLanding, useUnmergedTree = true).assertCountEquals(0)
    }

    /** The two links are OrbitKit's own words (`OpenItemDeliveryCard.openSession` / `.openLanding`), byte for byte. */
    @Test fun theLinksAreTheSwifts() {
        val root = generateSequence(java.io.File(System.getProperty("user.dir"))) { it.parentFile }
            .first { java.io.File(it, "src/macos/OrbitKit/Sources/OrbitKit").isDirectory }
        val swift = java.io.File(root, "src/macos/OrbitKit/Sources/OrbitKit/Transcript/OpenItemDelivery.swift").readText()
        listOf(OpenItemDeliveryCopy.openSession, OpenItemDeliveryCopy.openLanding).forEach {
            assertTrue("OpenItemDelivery.swift no longer says \"$it\"", swift.contains("\"$it\""))
        }
    }
}
