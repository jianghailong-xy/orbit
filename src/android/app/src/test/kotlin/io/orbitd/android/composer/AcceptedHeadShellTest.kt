package io.orbitd.android.composer

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import io.orbitd.android.core.net.ApiResponse
import org.junit.Assert.*
import org.junit.Test

/**
 * A07-14 (iOS 0588fe262; OrbitKit AcceptedTurnPlaceholderTests, AcceptedTurnWiringTests) over the controlled server: the conversation
 * reads its turns in the active view, and the head a runner has taken is drawn at the transcript's end as the person's turn — no
 * Cancel, no "Queued" — until its echo takes its place or its own turn_end ends it, a listing read before either notwithstanding.
 * The composer's queue is what is still waiting: neither the head nor a steer's receipt.
 */
class AcceptedHeadShellTest : ComposerShellTest() {
    private val headId = "01a0cca7-8609-70ed-a0e2-d4b55b832b71"
    private val head = """{"turnId":"$headId","kind":"message","placement":"accepted","content":"Write the release notes",
        "attachments":[],"createdAt":"2026-10-15T02:00:00.000Z"}"""
    private val drawn = hasTestTag("accepted:$headId")

    /** The listing the conversation reads — and keeps reading, so a re-read after an event is as stale as a server's can be. */
    private fun listing(json: String) {
        ComposerShell.answers["GET sessions/${ComposerShell.SESSION}/turns"] = { ApiResponse(200, json.encodeToByteArray()) }
    }

    /** A transcript whose last turn has ended, the head next. */
    private fun before() {
        ComposerShell.events = listOf(ComposerShell.obj("""{"type":"user","seq":1,"turnId":"t-0","payload":{"text":"Ship the build"}}"""),
            ComposerShell.obj("""{"type":"assistant","seq":2,"turnId":"t-0","payload":{"text":"Shipped."}}"""),
            ComposerShell.obj("""{"type":"turn_end","seq":3,"turnId":"t-0","payload":{"subtype":"success"}}"""))
    }

    @Test fun theHeadIsDrawnAsThePersonsTurnUntilItsEchoTakesItsPlace() {
        before(); listing("[$head]")
        signIn(); openSession()
        await { has(drawn) }
        assertTrue("the active view, which lists the head", ComposerShell.calls.contains("GET sessions/${ComposerShell.SESSION}/turns?view=active"))
        // The person's turn, where its echo will land: after the history, as the transcript draws one.
        assertTrue(has(hasText("Write the release notes") and hasAnyAncestor(drawn)))
        assertTrue(has(hasText("You") and hasAnyAncestor(drawn)))
        assertFalse("the runner has it: nothing withdraws it", has(hasText("Cancel")))
        assertFalse(shows("Queued"))
        val order = compose.onNodeWithTag("transcript-list").fetchSemanticsNode().children.map { it.config.getOrNull(SemanticsProperties.TestTag) }
        assertTrue("after the history: $order", order.indexOf("accepted:$headId") > order.indexOf("event:2"))

        // Its echo arrives; the listing the event makes the page read again still names the head.
        ComposerShell.push("""{"type":"user","seq":4,"turnId":"${headId.uppercase()}","payload":{"text":"Write the release notes"}}""")
        await { !has(drawn) }
        await { has(hasTestTag("event:4")) }
        assertEquals("drawn once", 1, compose.onAllNodes(hasText("Write the release notes") and hasAnyAncestor(hasTestTag("transcript-list")),
            useUnmergedTree = true).fetchSemanticsNodes().size)
    }

    private fun turnReads() = ComposerShell.calls.count { it.startsWith("GET sessions/${ComposerShell.SESSION}/turns") }

    @Test fun theHeadGoesWithItsOwnTurnsEnd() {
        before(); listing("[$head]")
        signIn(); openSession()
        await { has(drawn) }
        // Another turn's end leaves it — the page reads the listing again, which still names it — and its own ends it.
        val reads = turnReads()
        ComposerShell.push("""{"type":"turn_end","seq":4,"turnId":"t-other","payload":{"subtype":"success"}}""")
        await { turnReads() > reads }
        compose.waitForIdle()
        assertTrue(has(drawn))
        ComposerShell.push("""{"type":"turn_end","seq":5,"turnId":"$headId","payload":{"subtype":"error_during_execution"}}""")
        await { !has(drawn) }
    }

    @Test fun aCommandTheRunnerTookIsNoPlaceholder() {
        before(); listing("""[{"turnId":"t-sh","kind":"shell","placement":"accepted","content":"ls -la","attachments":[],"createdAt":"2026-10-15T02:00:00.000Z"}]""")
        signIn(); openSession()
        await { ComposerShell.calls.contains("GET sessions/${ComposerShell.SESSION}/turns?view=active") }
        compose.waitForIdle()
        assertFalse(has(hasTestTag("accepted:t-sh")))
        assertFalse(shows("ls -la"))
    }

    /** The composer's queue holds what is still waiting: the head is the runner's and a receipt is a steer that is over, so neither is
     * counted or offered a Withdraw — only the turn queued behind them, which goes when withdrawn. */
    @Test fun theQueuedMessagesAreWhatIsStillWaiting() {
        before()
        listing("""[$head,
            {"turnId":"t-steer","kind":"steer","placement":"steer","content":"use staging","attachments":[],"targetTurnId":"t-0",
              "delivery":"failed","deliveryCode":"CURRENT_WORK_TARGET_COMPLETED","createdAt":"2026-10-15T02:00:01.000Z"},
            {"turnId":"t-next","kind":"message","placement":"queued","content":"Then tag v2","attachments":[],"createdAt":"2026-10-15T02:00:02.000Z"}]""")
        signIn(); openSession()
        await { has(drawn) }
        compose.onNode(hasText("+") and hasClickAction()).performClick()
        await { shows("Queued messages (1)") }
        compose.onNodeWithText("Queued messages (1)").performClick()
        await { has(hasText("Then tag v2") and hasAnyAncestor(isDialog())) }
        assertFalse(has(hasText("Write the release notes") and hasAnyAncestor(isDialog())))
        assertFalse(has(hasText("use staging") and hasAnyAncestor(isDialog())))
        assertEquals(1, compose.onAllNodes(hasText("Withdraw") and hasAnyAncestor(isDialog())).fetchSemanticsNodes().size)
        compose.onNode(hasText("Withdraw") and hasClickAction()).performClick()
        await { ComposerShell.calls.contains("DELETE sessions/${ComposerShell.SESSION}/turns/t-next") }
    }
}
