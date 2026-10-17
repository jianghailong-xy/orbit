package io.orbitd.android.toast

import org.junit.Assert.*
import org.junit.Test

/** The toast system's rules, ported from OrbitKit `ToastFeedTests` (docs/mocks/toast-system, board ④): what a toast asks
 * of you decides its level, a failure is never displaced, and one operation is one toast from start to finish. */
class ToastFeedTest {
    private val t0 = 1_000_000_000L
    private var feed = ToastFeed()
    private fun post(item: ToastItem, at: Long): Long? = feed.post(item, at).let { (next, id) -> feed = next; id }

    // MARK: levels

    @Test fun whatAToastAsksOfYouDecidesItsLevel() {
        assertEquals(ToastLevel.CONFIRM, ToastItem("Link copied").level)
        assertEquals("naming its entry doesn't make a confirmation a card", ToastLevel.CONFIRM,
            ToastItem("Accepted", subtitle = "Use pnpm for workspace installs").level)
        assertEquals("a toast you can tap into its session is still a pill", ToastLevel.CONFIRM,
            ToastItem("Merged into main", sessionId = "s1").level)
        assertEquals(ToastLevel.PROGRESS, ToastItem("Merging into main…", inProgress = true).level)
        assertEquals(ToastLevel.RESULT, ToastItem("Session completed", sessionId = "s1", canUndo = true).level)
        assertEquals(ToastLevel.RESULT, ToastItem("Changes committed", detail = "1 file changed").level)
        assertEquals(ToastLevel.ATTENTION, ToastItem("Couldn't merge into main", tone = ToastTone.ERROR).level)
        assertEquals(ToastLevel.ATTENTION, ToastItem("Waiting for your approval", tone = ToastTone.WARNING).level)
        assertEquals("a failure waits for you whatever else it carries", ToastLevel.ATTENTION,
            ToastItem("Couldn't merge into main", tone = ToastTone.ERROR, inProgress = true).level)
    }

    @Test fun onlyTheOnesThatWaitForYouStayWithoutATimer() {
        assertEquals(3_000L, ToastItem("Link copied").dwellMillis)
        assertEquals(6_000L, ToastItem("Session completed", canUndo = true).dwellMillis)
        assertNull(ToastItem("Couldn't commit", tone = ToastTone.ERROR).dwellMillis)
        assertNotNull("a progress pill has a net under a result that never comes", ToastItem("Merging into main…", inProgress = true).dwellMillis)
    }

    // MARK: the slots

    @Test fun theNewestTransientToastWins() {
        post(ToastItem("Session completed", sessionId = "s1", canUndo = true), t0)
        post(ToastItem("Link copied"), t0 + 1_000)
        assertEquals("Link copied", feed.transient?.message)
        assertTrue(feed.pinned.isEmpty())
    }

    @Test fun aFailureIsNeverDisplacedByWhatComesAfterIt() {
        post(ToastItem("Couldn't merge into main", tone = ToastTone.ERROR), t0)
        post(ToastItem("Link copied"), t0 + 1_000)
        assertEquals(listOf("Couldn't merge into main"), feed.pinned.map { it.message })
        assertEquals("Link copied", feed.transient?.message)
    }

    @Test fun aNewFailureOpensAndTheNewestIsInFront() {
        val first = post(ToastItem("Couldn't save the schedule", tone = ToastTone.ERROR), t0)!!
        assertEquals(first, feed.expanded)
        val second = post(ToastItem("Couldn't merge into main", tone = ToastTone.ERROR), t0 + 1_000)!!
        assertEquals(second, feed.expanded)
        assertEquals(second, feed.front?.id)
        assertEquals(1, feed.behindFront)
    }

    @Test fun foldingAndUnfoldingAPinnedCard() {
        val id = post(ToastItem("Couldn't merge into main", tone = ToastTone.ERROR), t0)!!
        feed = feed.fold(id)
        assertNull(feed.expanded)
        assertEquals("folding keeps it on screen as a pill", 1, feed.pinned.size)
        val openings = feed.openings
        feed = feed.unfold(id)
        assertEquals(id, feed.expanded)
        assertEquals("opening it again starts its fold over", openings + 1, feed.openings)
        feed = feed.dismiss(id)
        assertTrue(feed.pinned.isEmpty())
        assertNull(feed.expanded)
    }

    @Test fun aTimerOnlyTakesDownTheToastItWasStartedFor() {
        val old = post(ToastItem("Session completed", canUndo = true), t0)!!
        post(ToastItem("Link copied"), t0 + 1_000)
        feed = feed.expire(old)
        assertEquals("Link copied", feed.transient?.message)
    }

    @Test fun twoTapsOnCopyAreOneToast() {
        assertNotNull(post(ToastItem("Link copied"), t0))
        assertNull(post(ToastItem("Link copied"), t0 + 500))
        assertNotNull(post(ToastItem("Link copied"), t0 + 3_000))
    }

    // MARK: one operation, one toast

    @Test fun aResultTakesItsProgressPillsPlace() {
        val pill = post(ToastItem("Merging into main…", key = "merge:s1", inProgress = true), t0)!!
        val revision = feed.transient!!.revision
        val result = post(ToastItem("Merged into main", sessionId = "s1", key = "merge:s1"), t0 + 20_000)
        assertEquals("same toast, new content — not a second arrival", pill, result)
        assertEquals("Merged into main", feed.transient?.message)
        assertEquals(ToastLevel.CONFIRM, feed.transient?.level)
        assertTrue("its timer starts over with what it says now", feed.transient!!.revision > revision)
    }

    @Test fun aFailedOperationsPillTurnsIntoAPinnedCard() {
        post(ToastItem("Merging into main…", key = "merge:s1", inProgress = true), t0)
        post(ToastItem("Couldn't merge into main", detail = "CONFLICT", tone = ToastTone.ERROR, key = "merge:s1"), t0 + 20_000)
        assertNull("the spinner goes", feed.transient)
        assertEquals(listOf("Couldn't merge into main"), feed.pinned.map { it.message })
        assertEquals(feed.pinned.first().id, feed.expanded)
    }

    @Test fun aRetrysSuccessClearsTheFailureItAnswered() {
        post(ToastItem("Couldn't merge into main", tone = ToastTone.ERROR, key = "merge:s1"), t0)
        post(ToastItem("Merged into main", key = "merge:s1"), t0 + 60_000)
        assertTrue(feed.pinned.isEmpty())
        assertNull(feed.expanded)
        assertEquals("Merged into main", feed.transient?.message)
    }

    @Test fun theSameFailureAgainUpdatesItsCard() {
        val id = post(ToastItem("Couldn't merge into main", detail = "first", tone = ToastTone.ERROR, key = "merge:s1"), t0)!!
        feed = feed.fold(id)
        val again = post(ToastItem("Couldn't merge into main", detail = "second", tone = ToastTone.ERROR, key = "merge:s1"), t0 + 30_000)
        assertEquals(id, again)
        assertEquals(listOf("second"), feed.pinned.map { it.detail })
        assertEquals("a new failure opens again", id, feed.expanded)
    }

    @Test fun keysBelongToOneOperation() {
        post(ToastItem("Merging into main…", key = "merge:s1", inProgress = true), t0)
        post(ToastItem("Merged into main", key = "merge:s2"), t0 + 1_000)
        assertEquals("another session's result is its own toast", "Merged into main", feed.transient?.message)
    }
}
