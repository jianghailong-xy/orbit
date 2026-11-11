package io.orbitd.android.reader

import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.cards.OrbitExchangeFold
import io.orbitd.android.core.realtime.RunEvent
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * A run of turns Orbit opened, as the reader draws it (web Transcript.orbitFold.test.tsx, design docs/mocks/coordinator-exchange-fold/):
 * one line that counts them, opening to a tree by task — the task each waits on above it, roots shut — and an exchange opening back to
 * exactly the rows it folds. A record a link lands on opens the way down to it.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h891dp")
class ExchangeFoldViewTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()

    private val b1 = "0195c0de-0000-7000-8000-000000000011"
    private val b4 = "0195c0de-0000-7000-8000-000000000014"
    private val runOfB1 = "0195c0de-0000-7000-8000-0000000000a1"
    private val watch = "0195c0de-0000-7000-8000-0000000000c3"
    private var seq = 0L

    private fun delivery(kind: String, task: String, title: String, revision: Int? = null) = buildJsonObject {
        put("text", "From Orbit · project “Link” has news about $title")
        putJsonObject("coordinatorDelivery") {
            put("kind", kind); putJsonObject("task") { put("id", task); put("title", title) }
            put("revision", revision?.let(::JsonPrimitive) ?: JsonNull); put("count", JsonNull); put("deliveredAt", "2026-11-11T09:00:00Z")
        }
    }
    private val watchText = listOf("Orbit Watch $watch matched at generation 1: SESSION_IDLE 1/1", "",
        "This turn was queued by the watch, not typed by a person. What the watch recorded when its condition held:", "", "```json",
        """{"watchId":"$watch","generation":1,"changedTargets":[{"kind":"SESSION","id":"$runOfB1","state":"IDLE"}]}""", "```").joinToString("\n")

    private fun exchange(opening: JsonObject, reply: String): List<RunEvent> {
        val id = "turn-$seq"
        return listOf(RunEvent("user", ++seq, opening, id, "2026-11-11T09:${10 + seq}:00Z"),
            RunEvent("assistant", ++seq, buildJsonObject { put("text", reply) }, id), RunEvent("turn_end", ++seq, buildJsonObject { }, id))
    }
    private val events = listOf(
        exchange(delivery("EVIDENCE_SUBMITTED", b1, "B1 Targeted hints", 2), "我确认了 B1，它正在落地。"),
        exchange(buildJsonObject { put("text", watchText) }, "这是之前设的提醒，不用再做什么。"),
        exchange(delivery("DEPENDENT_READY", b4, "B4 Link gateway"), "B4 已经开工。"),
        exchange(buildJsonObject { put("text", "ok") }, "Done."),
    ).flatten()
    private val group = ExchangeFold.fold(Steps.group(transcriptRows(events))).single { it.exchanges.isNotEmpty() }
    private var wanted = 0
    private val tree = ExchangeTree(object : OrbitExchangeFold.Lookup {
        override fun taskOfSession(sessionId: String) = if (sessionId == runOfB1) b1 to null else null
        override fun upstreamOf(taskId: String) = if (taskId == b4) listOf(b1) else emptyList()
    }) { wanted++ }

    private fun show(target: Long? = null) {
        compose.runOnUiThread { compose.activity.setContent { MaterialTheme {
            CompositionLocalProvider(LocalExchangeTree provides tree) {
                ExchangeFoldView(group, target) { row: TranscriptRow -> Leaf(row) }
            }
        } } }
        compose.waitForIdle()
    }
    @Composable private fun Leaf(row: TranscriptRow) = Text("leaf:${row.event.seq}:${row.event.body()}")
    private fun text(t: String) = compose.onNodeWithText(t, useUnmergedTree = true)
    private fun none(t: String) = compose.onAllNodesWithText(t, substring = true, useUnmergedTree = true).assertCountEquals(0)

    @Test fun oneLineOpensToTasksThenToRowsThenToWhatTheyFold() {
        show()
        text("3 Orbit updates handled").assertIsDisplayed()
        none("B1 Targeted hints")
        assertEquals("nothing is read before a group opens", 0, wanted)

        compose.onNodeWithTag("exchanges-line", useUnmergedTree = true).performClick(); compose.waitForIdle()
        assertEquals(1, wanted)
        // One root: B1, B4 under it, shut. Shut, a branch sums up everything below it.
        text("B1 Targeted hints").assertIsDisplayed()
        text("3 updates · 1 downstream · last: B4 已经开工。").assertIsDisplayed()
        none("B4 Link gateway")

        compose.onAllNodesWithTag("branch-line", useUnmergedTree = true)[0].performClick(); compose.waitForIdle()
        // Under its task a row drops the task's name; the watch on B1's run is B1's.
        text("Evidence revision 2 submitted").assertIsDisplayed()
        text("Watch triggered").assertIsDisplayed()
        text("我确认了 B1，它正在落地。").assertIsDisplayed()
        text("B4 Link gateway").assertIsDisplayed()
        none("leaf:")

        text("Evidence revision 2 submitted").performClick(); compose.waitForIdle()
        text("leaf:1:From Orbit · project “Link” has news about B1 Targeted hints").assertIsDisplayed()
        text("leaf:2:我确认了 B1，它正在落地。").assertIsDisplayed()
        none("leaf:4")
    }

    @Test fun aRecordALinkLandsOnOpensTheWayDownToIt() {
        show(target = 5)
        text("leaf:5:这是之前设的提醒，不用再做什么。").assertIsDisplayed()
        // Only the exchange holding it opens.
        none("leaf:2")
    }
}
