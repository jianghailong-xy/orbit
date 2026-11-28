package io.orbitd.android.core.protocol

import java.time.Instant
import org.junit.Assert.*
import org.junit.Test

/** The mode changes a transcript holds as it pages back (web permissionModeChangeHistory.test.ts states the same rules). */
class ModeChangeHistoryTest {
    private val t0 = Instant.parse("2026-11-27T05:00:00Z")
    private fun at(s: Long) = t0.plusSeconds(s).toString()
    /** The change numbered [seq], Auto and Plan in turn, one a second. */
    private fun c(seq: Long) = PermissionModeChange(if (seq % 2 == 1L) "auto" else "plan", if (seq % 2 == 1L) "plan" else "auto",
        "OWNER_PICK", "android", at(seq), seq)
    private fun range(from: Long, to: Long) = (from..to).map(::c)
    private fun ModeChangeHistory.seqs() = changes.map { it.seq }

    @Test fun takesInTheDetailAndKeepsItselfWhenAReadAddsNothing() {
        val held = ModeChangeHistory().adopt(range(11, 60), true)
        assertEquals((11L..60L).toList(), held.seqs())
        assertTrue(held.hasMore)
        assertSame(held, held.adopt(range(11, 60), true))
        val empty = ModeChangeHistory().adopt(emptyList(), false)
        assertSame(empty, empty.adopt(emptyList(), false))
    }

    @Test fun keepsAChangeThatFallsOutOfTheNewestFiftyAndAddsTheNewOnesOnce() {
        val next = ModeChangeHistory(range(1, 60), false).adopt(range(13, 62), true)
        assertEquals((1L..62L).toList(), next.seqs())
        assertFalse(next.hasMore)
    }

    @Test fun startsAgainFromADetailThatNoLongerReachesWhatItHolds() {
        val next = ModeChangeHistory(range(1, 60), false).adopt(range(71, 120), true)
        assertEquals((71L..120L).toList(), next.seqs())
        assertTrue(next.hasMore)
    }

    @Test fun aPageGoesOnlyOntoTheOldestItWasReadFor() {
        val held = ModeChangeHistory(range(11, 60), true)
        val paged = held.withOlder(11, ModeChangePage(range(1, 10), false))
        assertEquals((1L..60L).toList(), paged.seqs())
        assertFalse(paged.hasMore)
        assertSame(held, held.withOlder(5, ModeChangePage(range(1, 4), false)))
    }

    @Test fun anOlderServerIsHeldAsItSaysAndPagesNothing() {
        val unnumbered = listOf(PermissionModeChange(null, "auto", "CLAIM", null, at(1)))
        val held = ModeChangeHistory().adopt(unnumbered, true)
        assertEquals(unnumbered, held.changes)
        assertSame(held, held.adopt(unnumbered, true))
        assertFalse(held.needsOlder(at(0), true))
    }

    @Test fun readsOlderOnesOnlyAsFarBackAsTheWindowAndAllOfThemAtTheStart() {
        val held = ModeChangeHistory(range(11, 60), true)
        assertFalse(held.needsOlder(at(30), false))
        assertTrue(held.needsOlder(at(11), false))
        assertTrue(held.needsOlder(at(5), false))
        assertTrue(held.needsOlder(at(30), true))
        assertFalse(held.needsOlder(null, true))
        assertFalse(held.copy(hasMore = false).needsOlder(at(5), true))
    }
}
