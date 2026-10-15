package io.orbitd.android.composer

import androidx.compose.ui.test.*
import io.orbitd.android.core.cards.WatchWakeQueue
import io.orbitd.android.core.net.ApiResponse
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.*
import org.junit.Test

/**
 * A07-14 with A08-14 (iOS 0588fe262, f8fdf50f0 `WatchWakeCardView`) over the controlled server: a watch's wake is one row in two
 * states. While it waits it is the tail's — its line dashed, the queue's own line under it, and a withdraw that asks first, from the
 * line and from the composer's queue alike — and once the runner has it, the accepted head: the same line, solid, with nothing to
 * withdraw and nothing counted.
 */
class WatchWakeQueueShellTest : ComposerShellTest() {
    private val turnId = "01a0cca7-8609-70ed-a0e2-d4b55b8314a8"
    private val watchId = "0199a8f0-1111-7aaa-8bbb-0000deadbeef"
    private val wake = "Orbit Watch $watchId matched at generation 1: ALL TASK_DONE 1/1\n" +
        "This turn was queued by the watch, not typed by a person.\n```json\n{\"watchId\":\"$watchId\",\"changedTargets\":" +
        "[{\"kind\":\"TASK\",\"id\":\"0199a8f0-2222-7aaa-8bbb-00000000c0de\",\"observed\":{\"status\":\"DONE\"}}]}\n```"
    private val tail = hasTestTag("queued:$turnId")
    private val head = hasTestTag("accepted:$turnId")

    /** The listing the conversation reads, the wake in it as [placement] says. */
    private fun listing(placement: String) {
        val json = """[{"turnId":"$turnId","kind":"message","placement":"$placement","content":${JsonPrimitive(wake)},"attachments":[],
            "authoredByOrbit":true,"createdAt":"2026-10-15T02:00:00.000Z"}]"""
        ComposerShell.answers["GET sessions/${ComposerShell.SESSION}/turns"] = { ApiResponse(200, json.encodeToByteArray()) }
    }

    /** A transcript whose last turn has ended, the wake next. */
    private fun before() {
        ComposerShell.events = listOf(ComposerShell.obj("""{"type":"user","seq":1,"turnId":"t-0","payload":{"text":"Watch the release task"}}"""),
            ComposerShell.obj("""{"type":"turn_end","seq":2,"turnId":"t-0","payload":{"subtype":"success"}}"""))
    }

    private fun withdrawals() = ComposerShell.calls.count { it == "DELETE sessions/${ComposerShell.SESSION}/turns/$turnId" }
    private fun inDialog(text: String) = hasText(text) and hasClickAction() and hasAnyAncestor(isDialog())

    @Test fun theSameWakeIsTheTailsDashedLineUntilTheRunnerTakesItThenTheAcceptedHead() {
        before(); listing("queued")
        signIn(); openSession()
        await { has(hasTestTag("watch-wake:queued") and hasAnyAncestor(tail), unmerged = true) }
        assertTrue(has(hasText(WatchWakeQueue.status) and hasAnyAncestor(tail), unmerged = true))
        assertFalse("queued, it is no head", has(head))
        // Withdrawing asks first; keeping it withdraws nothing.
        compose.onNodeWithTag("watch-wake:withdraw").performClick()
        await { shows(WatchWakeQueue.confirmTitle) }
        compose.onNodeWithTag("watch-wake:keep").performClick()
        await { !shows(WatchWakeQueue.confirmTitle) }
        assertEquals(0, withdrawals())

        // The runner takes it: the listing the next event makes the page read names it accepted.
        listing("accepted")
        ComposerShell.push("""{"type":"turn_end","seq":3,"turnId":"t-other","payload":{"subtype":"success"}}""")
        await { has(head) }
        assertFalse("no row of the queue's", has(tail))
        assertTrue("the same line", has(hasTestTag("watch-wake:line") and hasAnyAncestor(head), unmerged = true))
        assertFalse("solid", has(hasTestTag("watch-wake:queued"), unmerged = true))
        assertFalse("nothing withdraws it", has(hasTestTag("watch-wake:withdraw"), unmerged = true))
        assertFalse(shows(WatchWakeQueue.status))
        compose.onNode(hasText("+") and hasClickAction()).performClick()
        await { shows("Queued messages (0)") }
    }

    @Test fun withdrawingAQueuedWakeAsksFirstFromTheComposersQueueAndFromTheLine() {
        before(); listing("queued")
        signIn(); openSession()
        await { has(hasTestTag("watch-wake:withdraw")) }
        // The composer's queue counts it, and its Withdraw asks the line's question.
        compose.onNode(hasText("+") and hasClickAction()).performClick()
        await { shows("Queued messages (1)") }
        compose.onNodeWithText("Queued messages (1)").performClick()
        await { has(inDialog("Withdraw")) }
        compose.onNode(inDialog("Withdraw")).performClick()
        await { shows(WatchWakeQueue.confirmTitle) }
        assertTrue(shows(WatchWakeQueue.consequence))
        compose.onNode(inDialog(WatchWakeQueue.keep)).performClick()
        await { !shows(WatchWakeQueue.confirmTitle) }
        assertEquals("keeping it withdraws nothing", 0, withdrawals())
        compose.onNode(inDialog("Withdraw")).performClick()
        await { shows(WatchWakeQueue.confirmTitle) }
        compose.onNode(inDialog(WatchWakeQueue.withdraw)).performClick()
        await { withdrawals() == 1 }
        compose.onNode(inDialog("Close")).performClick()

        // The line's own: asks, then the same DELETE — once the composer is no longer busy with the first.
        await { !has(isDialog()) && has(hasTestTag("watch-wake:withdraw")) }
        compose.onNodeWithTag("watch-wake:withdraw").performClick()
        await { shows(WatchWakeQueue.confirmTitle) }
        compose.onNodeWithTag("watch-wake:confirm-withdraw").performClick()
        await { withdrawals() == 2 }
    }
}
