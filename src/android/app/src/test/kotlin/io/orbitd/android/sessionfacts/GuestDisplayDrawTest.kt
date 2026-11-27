package io.orbitd.android.sessionfacts

import android.content.ComponentName
import androidx.activity.ComponentActivity
import androidx.compose.foundation.layout.Column
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import io.orbitd.android.core.guests.GuestSessionSummary
import io.orbitd.android.core.guests.GuestWire
import io.orbitd.android.core.guests.SharedWithMe
import io.orbitd.android.core.guests.marks
import io.orbitd.android.core.guests.word
import io.orbitd.android.navigation.DrawerSharedWithMe
import io.orbitd.android.reader.GuestHead
import io.orbitd.android.ui.OrbitTheme
import java.io.File
import kotlinx.serialization.json.*
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.ExternalResource
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * The guest view's head and the Shared with me row as drawn, on the server's own payloads for the cross-client check's 23 cases
 * (guest-payloads.json; what each says is GuestDisplayRowsTest's): with the facts, the head draws the state icon, the word and one chip
 * per mark, and the row says them in web's line; without them, neither draws a state icon or a chip.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = io.orbitd.android.TestOrbitApplication::class, qualifiers = "w411dp-h891dp")
class GuestDisplayDrawTest {
    @get:Rule(order = 0) val host = object : ExternalResource() {
        override fun before() {
            val app = RuntimeEnvironment.getApplication()
            shadowOf(app.packageManager).addActivityIfNotPresent(ComponentName(app, ComponentActivity::class.java))
        }
    }
    @get:Rule(order = 1) val compose = createComposeRule()

    private val cases = Json.parseToJsonElement(
        File("../../../scripts/acceptance/session-three-state-check/guest/guest-payloads.json").readText()).jsonArray.map { it.jsonObject }
    private val facts = setOf("phase", "released", "lastTurnOutcome", "waitingOn", "endReason", "workFinished")
    private val stateTags = listOf("QUEUED", "RUNNING", "IDLE").map { "session-state-icon:$it" }
    private val markTags = listOf("NEEDS_YOU", "FAILED", "RETRYING", "ON_HOLD", "INTERRUPTED", "BACKGROUND", "WILL_RESUME", "FINISHED", "ENDED")

    private fun row(p: JsonObject): GuestSessionSummary = GuestWire.list(buildJsonObject { put("sessions", buildJsonArray { add(p) }) }
        .toString().encodeToByteArray()).single()
    private fun present(tag: String) = compose.onAllNodesWithTag(tag, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()

    @Test fun everyCaseDrawsItsStateAndMarksWithTheFactsAndNeitherWithout() {
        val shown = mutableStateOf(cases[0])
        compose.setContent {
            OrbitTheme {
                Column {
                    GuestHead(GuestWire.state(shown.value["sharedHead"]!!.jsonObject))
                    DrawerSharedWithMe(listOf(row(shown.value["guestRow"]!!.jsonObject)), null) { _, _ -> }
                }
            }
        }
        for (case in cases) for (older in listOf(false, true)) {
            val payloads = if (!older) case else JsonObject(case + listOf("sharedHead", "guestRow")
                .associateWith { JsonObject(case[it]!!.jsonObject - facts) })
            val name = "${case["name"]!!.jsonPrimitive.content}${if (older) " without facts" else ""}"
            shown.value = payloads
            compose.waitForIdle()
            val head = GuestWire.state(payloads["sharedHead"]!!.jsonObject)
            val marks = head.marks.orEmpty()
            assertEquals("$name state icon", if (older) listOf<String>() else listOf("session-state-icon:${head.word.uppercase()}"),
                stateTags.filter(::present))
            assertEquals("$name chips", markTags.filter { tag -> marks.any { it.name == tag } },
                markTags.filter { present("session-mark:$it") })
            compose.onNodeWithText(head.word, useUnmergedTree = true).assertIsDisplayed()
            compose.onNodeWithTag("guest-badge", useUnmergedTree = true).assertIsDisplayed()
            assertEquals("$name Completed", false, present("guest-completed"))
            val said = compose.onNodeWithTag("guest-head", useUnmergedTree = true).fetchSemanticsNode().children
                .mapNotNull { it.config.getOrNull(SemanticsProperties.ContentDescription)?.joinToString() }
            assertEquals("$name marks said", if (marks.isEmpty()) listOf() else listOf(marks.joinToString(", ") { it.word }), said)
            compose.onNodeWithText(SharedWithMe.subtitle(row(payloads["guestRow"]!!.jsonObject)), useUnmergedTree = true).assertExists()
        }
    }

    @Test fun aFiledSessionsHeadSaysCompletedAfterItsMarks() {
        val head = JsonObject(cases.single { it["name"]!!.jsonPrimitive.content == "SUCCEEDED" }["sharedHead"]!!.jsonObject +
            ("lifecycleState" to JsonPrimitive("COMPLETED")))
        compose.setContent { OrbitTheme { GuestHead(GuestWire.state(head)) } }
        compose.onNodeWithText("Idle", useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithTag("session-mark:FINISHED", useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithTag("guest-completed", useUnmergedTree = true).assertIsDisplayed()
        compose.onNodeWithText("Completed", useUnmergedTree = true).assertIsDisplayed()
    }
}
