package io.orbitd.android.cards

import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

/** The held card's quiet window (web `keepLanding`): only a put-back that moved the card restarts it. */
class CardFocusHoldTest {
    private val session = "34A05dSessionWaiting03"
    private var wall = 0L
    @Before fun clock() { wall = 1_000_000L; CardFocus.now = { wall }; CardFocus.release(session); CardFocus.report(session, "approval:a", 184f); CardFocus.hold(session, "approval:a", true) }
    @After fun realClock() { CardFocus.release(session); CardFocus.now = { System.currentTimeMillis() } }

    /** The conversation keeps changing while the card is already in place: nothing moves it, so five seconds after it was placed it lets go. */
    @Test fun aHoldReleasesFiveSecondsAfterItLastMovedWhateverKeepsLanding() {
        repeat(2) { wall += 2_000; assertTrue("held while the quiet runs", CardFocus.reapply(session)) }
        wall += 2_000
        assertFalse("six seconds with nothing moving it", CardFocus.reapply(session))
        assertNull(CardFocus.held(session))
    }

    /** A put-back that moved the card starts the quiet again. */
    @Test fun aPutBackThatMovedTheCardRestartsTheQuiet() {
        wall += 4_000; assertTrue(CardFocus.reapply(session)); CardFocus.moved(session)
        wall += 4_000; assertTrue("four seconds after it last moved", CardFocus.reapply(session))
        wall += 2_000; assertFalse("six seconds after it last moved", CardFocus.reapply(session))
    }
}
