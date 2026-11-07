package io.orbitd.android.realtime

import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Test

/** docs/list-freshness-design.md §4 R1, R2 and R4 for a page's poll ([PagePolls.follow]), on a test clock: when it reads, by the account
 * stream's state and its events. */
@OptIn(ExperimentalCoroutinesApi::class)
class PagePollTest {
    private class Rig(val scope: TestScope, connected: Boolean = true) {
        val signal = MutableStateFlow(PageSignal(connected, 0))
        /** When each read began, in ms of the test clock. */
        val reads = mutableListOf<Long>()
        var inFlightMs: Long? = null
        fun start() = scope.backgroundScope.launch {
            PagePolls.follow(signal, { inFlightMs }, jitter = { 1.0 }) { reads += scope.currentTime }
        }.also { scope.runCurrent() }
        fun event() { signal.value = signal.value.copy(nudges = signal.value.nudges + 1) }
        fun connected(up: Boolean) { signal.value = PageSignal(up, signal.value.nudges + if (up) 1 else 0) }
    }

    /** R1: the stream up and nothing happening, a read when the page opens and then one a minute — never more. */
    @Test fun withTheStreamUpAndNoEventsAPageReadsOnceAMinute() = runTest {
        val rig = Rig(this)
        rig.start()
        advanceTimeBy(PagePolls.FALLBACK_MS - 1); runCurrent()
        assertEquals(listOf(0L), rig.reads)
        advanceTimeBy(1); runCurrent()
        advanceTimeBy(2 * PagePolls.FALLBACK_MS); runCurrent()
        assertEquals(listOf(0L, 60_000L, 120_000L, 180_000L), rig.reads)
    }

    /** An event that can move what the page shows is read shortly after it, once for a burst; the minute counts again from that read. */
    @Test fun aBurstOfEventsIsOneRead() = runTest {
        val rig = Rig(this)
        rig.start()
        advanceTimeBy(10_000); runCurrent()
        repeat(5) { rig.event(); runCurrent(); advanceTimeBy(100) }
        advanceTimeBy(PagePolls.NUDGE_MS); runCurrent()
        assertEquals(listOf(0L, 10_000L + PagePolls.NUDGE_MS), rig.reads)
        advanceTimeBy(PagePolls.FALLBACK_MS); runCurrent()
        assertEquals(listOf(0L, 12_000L, 72_000L), rig.reads)
    }

    /** R2: with the stream down, the page reads on a backoff of 4, 8 and 16 s, then every 30 s. */
    @Test fun withTheStreamDownAPageBacksOff() = runTest {
        val rig = Rig(this, connected = false)
        rig.start()
        advanceTimeBy(120_000); runCurrent()
        assertEquals(listOf(0L, 4_000L, 12_000L, 28_000L, 58_000L, 88_000L, 118_000L), rig.reads)
    }

    /** R4: the stream coming back is read at once, and the page follows it from there; a drop reads nothing until the backoff's first
     * step. */
    @Test fun aReconnectIsReadAtOnceAndADropWaitsOutTheBackoff() = runTest {
        val rig = Rig(this, connected = false)
        rig.start()
        advanceTimeBy(5_000); runCurrent()
        rig.connected(true); runCurrent()
        assertEquals(listOf(0L, 4_000L, 5_000L), rig.reads)
        advanceTimeBy(30_000); runCurrent()
        rig.connected(false); runCurrent()
        assertEquals("a drop is no read", listOf(0L, 4_000L, 5_000L), rig.reads)
        advanceTimeBy(4_000); runCurrent()
        assertEquals(listOf(0L, 4_000L, 5_000L, 39_000L), rig.reads)
    }

    /** A state no event announces keeps its bounded cadence while it is in flight, whatever the stream does — and once it is no longer in
     * flight the page follows the stream again: nothing for a minute. */
    @Test fun anInFlightCadenceStopsOnceNothingIsInFlight() = runTest {
        val rig = Rig(this)
        rig.inFlightMs = 4_000
        rig.start()
        advanceTimeBy(12_000); runCurrent()
        assertEquals(listOf(0L, 4_000L, 8_000L, 12_000L), rig.reads)
        rig.inFlightMs = null
        advanceTimeBy(4_000); runCurrent()
        assertEquals("the read in flight finds nothing in flight", listOf(0L, 4_000L, 8_000L, 12_000L, 16_000L), rig.reads)
        advanceTimeBy(PagePolls.FALLBACK_MS - 1); runCurrent()
        assertEquals(5, rig.reads.size)
        advanceTimeBy(1); runCurrent()
        assertEquals(16_000L + PagePolls.FALLBACK_MS, rig.reads.last())
    }

    @Test fun theBackoffIsFourEightSixteenThenThirtySecondsLessUpToAFifth() {
        assertEquals(listOf(4_000L, 8_000L, 16_000L, 30_000L, 30_000L), (0..4).map { PagePolls.backoffMs(it, 1.0) })
        assertEquals(listOf(3_200L, 6_400L, 12_800L, 24_000L), (0..3).map { PagePolls.backoffMs(it, 0.0) })
    }
}
