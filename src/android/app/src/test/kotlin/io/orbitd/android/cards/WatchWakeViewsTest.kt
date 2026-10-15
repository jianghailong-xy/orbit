package io.orbitd.android.cards

import androidx.activity.compose.setContent
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import io.orbitd.android.MainActivity
import io.orbitd.android.TestOrbitApplication
import io.orbitd.android.core.cards.*
import io.orbitd.android.core.realtime.RunEvent
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** A watch's wake as one event line (A08-14; iOS `WatchWakeCardView`): delivered with one target that came out DONE, with a failed
 * target among several, and still queued — dashed, with the queue's line, whose withdraw asks first — and the names its targets get. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [29], application = TestOrbitApplication::class, qualifiers = "w411dp-h891dp")
class WatchWakeViewsTest {
    @get:Rule val compose = createAndroidComposeRule<MainActivity>()
    private val watchId = "0199a8f0-1111-7aaa-8bbb-0000deadbeef"
    private val opened = mutableListOf<String>()

    private fun target(kind: String, id: String, status: String) = buildJsonObject {
        put("kind", kind); put("id", id); put("state", "SATISFIED"); putJsonObject("observed") { put("status", status) }
    }
    private fun wake(vararg targets: JsonObject, head: String = "matched at generation 2: ALL TASK_TERMINAL ${targets.size}/${targets.size}"): JsonObject {
        val text = "Orbit Watch $watchId $head\nThis turn was queued by the watch, not typed by a person.\n```json\n" +
            buildJsonObject { put("watchId", watchId); put("changedTargets", JsonArray(targets.toList())) } + "\n```"
        return transcriptCards(RunEvent("user", 3, buildJsonObject { put("text", text) })).single { it.key.endsWith(":watch") }.source
    }
    /** The line's words are measured once wide before they are laid out (`FitsOrStack`), so a part of the line may be in the tree twice. */
    private fun line(tag: String) = compose.onAllNodesWithTag(tag, useUnmergedTree = true)
    private fun shown(tag: String) = assertTrue("$tag is drawn", line(tag).fetchSemanticsNodes().isNotEmpty())
    private fun notShown(tag: String) = line(tag).assertCountEquals(0)

    private fun show(wake: JsonObject, queued: Boolean = false, withdraw: (() -> Unit)? = null, names: (String, JsonObject) -> String? = { _, _ -> null }) {
        compose.runOnUiThread { compose.activity.setContent { MaterialTheme { CompositionLocalProvider(LocalWatchTargetNames provides names) {
            WatchWakeLine(wake, "2026-10-15T01:00:00Z", { opened += it }, queued = queued, onWithdraw = withdraw)
        } } } }
        compose.waitForIdle()
    }

    @Test fun aDeliveredWakeIsOneLineThatOpensToTheRest() {
        val task = "0199a8f0-2222-7aaa-8bbb-00000000c0de"
        show(wake(target("TASK", task, "DONE")), names = { watch, t -> if (watch == watchId && t.text("id") == task) "Land the redirect fix" else null })
        shown("watch-wake:eye")
        notShown("watch-wake:failed")
        assertTrue(compose.onAllNodesWithText("Watch triggered", useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty())
        line("watch-wake:name").onFirst().assertTextEquals("Land the redirect fix")
        line("watch-wake:status").onFirst().assertTextEquals("DONE")
        assertTrue(compose.onAllNodesWithText(WatchWakeCard.details, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty())
        compose.onNodeWithTag("watch-wake:fold").assertDoesNotExist()
        compose.onNodeWithTag("watch-wake:queue").assertDoesNotExist()
        compose.onNodeWithTag("watch-wake:line").performClick()
        compose.onNodeWithTag("watch-wake:why", useUnmergedTree = true).assertTextEquals("1 of 1 finished")
        compose.onNodeWithTag("watch-wake:target:$task", useUnmergedTree = true).assertTextEquals("Task Land the redirect fix is now DONE").performClick()
        compose.onNodeWithTag("watch-wake:meta", useUnmergedTree = true).assertTextEquals("Queued by a watch, not typed by you · generation 2")
        compose.onNodeWithTag("watch-wake:view-watch", useUnmergedTree = true).performClick()
        assertEquals(listOf("orbit-task:$task", "orbit://watch/$watchId"), opened)
        compose.onNodeWithTag("watch-wake:received").assertDoesNotExist()
        compose.onNodeWithTag("watch-wake:raw").performClick()
        compose.onNodeWithTag("watch-wake:received", useUnmergedTree = true).assertTextContains("Orbit Watch $watchId matched", substring = true)
    }

    @Test fun aFailedTargetAmongSeveralMarksTheLineAndStaysInView() {
        show(wake(target("TASK", "a-00000001", "DONE"), target("TASK", "b-00000002", "FAILED"), target("TASK", "c-00000003", "DONE")))
        shown("watch-wake:failed")
        notShown("watch-wake:eye")
        line("watch-wake:name").onFirst().assertTextEquals("3 tasks")
        line("watch-wake:status").onFirst().assertTextEquals("1 of 3 failed")
        compose.onNodeWithTag("watch-wake:failures").assertExists()
        compose.onNodeWithTag("watch-wake:target:b-00000002", useUnmergedTree = true).assertTextEquals("Task 00000002 is now FAILED")
        compose.onNodeWithTag("watch-wake:target:a-00000001", useUnmergedTree = true).assertDoesNotExist()
        compose.onNodeWithTag("watch-wake:line").performClick()
        compose.onNodeWithTag("watch-wake:failures").assertDoesNotExist()
        compose.onNodeWithTag("watch-wake:target:a-00000001", useUnmergedTree = true).assertExists()
    }

    @Test fun aQueuedWakeIsDashedAndWithdrawingItAsksFirst() {
        var withdrawn = 0
        show(wake(target("SESSION", "s-12345678", "IDLE"), head = "matched at generation 1: ALL SESSION_TURN_SETTLED 1/1"), queued = true, withdraw = { withdrawn++ })
        compose.onNodeWithTag("watch-wake:queued", useUnmergedTree = true).assertExists()
        compose.onNodeWithText(WatchWakeQueue.status, useUnmergedTree = true).assertExists()
        line("watch-wake:name").onFirst().assertTextEquals("Session 12345678")
        compose.onNodeWithTag("watch-wake:withdraw").performClick()
        compose.onNodeWithText(WatchWakeQueue.confirmTitle).assertExists()
        compose.onNodeWithText(WatchWakeQueue.consequence).assertExists()
        compose.onNodeWithTag("watch-wake:keep").assertTextEquals(WatchWakeQueue.keep).performClick()
        compose.onNodeWithText(WatchWakeQueue.confirmTitle).assertDoesNotExist()
        assertEquals("keeping it withdraws nothing", 0, withdrawn)
        compose.onNodeWithTag("watch-wake:withdraw").performClick()
        compose.onNodeWithTag("watch-wake:confirm-withdraw").assertTextEquals(WatchWakeQueue.withdraw).performClick()
        assertEquals(1, withdrawn)
    }

    @Test fun aSettledWakeHasNoQueueLine() {
        show(wake(target("TASK", "t-1", "DONE")))
        compose.onNodeWithTag("watch-wake:queued", useUnmergedTree = true).assertDoesNotExist()
        compose.onNodeWithTag("watch-wake:withdraw").assertDoesNotExist()
    }

    /** The names, by either spelling of an id: the watch's own targets first, then the session list, then this conversation's Tasks
     * card; nothing held is no name, and the line falls back to the id's last eight. */
    @Test fun targetsAreNamedInTheOrderTheClientHoldsThem() {
        val uuid = "0199a8f0-2222-7aaa-8bbb-00000000c0de"
        val publicId = io.orbitd.android.navigation.ObjectId.toPublic(uuid)
        val watches = listOf(buildJsonObject { put("id", io.orbitd.android.navigation.ObjectId.toPublic(watchId))
            putJsonArray("targets") { addJsonObject { put("targetKind", "TASK"); put("targetResourceId", publicId); put("targetTitle", "From the watch") } } })
        val created = buildJsonObject { putJsonArray("items") { addJsonObject { put("id", publicId); put("title", "From the Tasks card") } } }
        val task = target("TASK", uuid, "DONE")
        assertEquals("From the watch", watchTargetName(watchId, task, watches, { null }, created))
        assertEquals("From the Tasks card", watchTargetName(watchId, task, emptyList(), { null }, created))
        assertNull(watchTargetName(watchId, task, emptyList(), { "a session's title" }, null))
        val session = target("SESSION", uuid, "IDLE")
        assertEquals("Coordinator", watchTargetName(watchId, session, emptyList(), { if (it == uuid) "Coordinator" else null }, created))
        assertNull(watchTargetName("another-watch", target("TASK", "x-1", "DONE"), watches, { null }, null))
    }
}
