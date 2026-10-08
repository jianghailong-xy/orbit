package io.orbitd.android.core.realtime

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

class ReadingWindowTest {
    private fun rows(from: Int, to: Int) = (from..to).map { RunEvent("assistant", it.toLong(), buildJsonObject { put("text", "record $it") }) }
    @Test fun tenMinuteDeltaStreamRetainsDurableListIdentityAndFinalizes() {
        var transcript = Transcript().tail(EventPage(rows(1, 200), true))
        val events = transcript.events
        repeat(12_000) {
            transcript = transcript.apply(RunEvent("text_delta", payload = buildJsonObject { put("delta", "中") }))
            assertSame(events, transcript.events)
        }
        assertEquals(12_000, transcript.textDrafts[""]!!.length)
        transcript = transcript.apply(RunEvent("assistant", 201, buildJsonObject { put("text", "final authoritative body") }))
        assertTrue(transcript.textDrafts.isEmpty())
        assertEquals(201, transcript.events.size)
    }
    @Test fun twentyPrependPagesKeepNearEdgeAndExposeNewerCursorAtBound() {
        var window = ReadingWindow().seed(EventPage(rows(9_801, 10_000), true))
        repeat(20) {
            val before = window.events.first().seq.toInt()
            window = window.older(EventPage(rows(before - 200, before - 1), true))
            assertEquals((before - 200).toLong(), window.events.first().seq)
            assertTrue(window.events.size <= ReadingWindow.LIMIT)
            assertEquals(window.events.size, window.events.map { e -> e.seq }.distinct().size)
        }
        assertEquals(5_801L, window.events.first().seq)
        assertEquals(7_800L, window.newerAfter)
        val older = window.events
        val withLive = window.live(Transcript().tail(EventPage(rows(9_801, 10_001), true)), false)
        assertSame(older, withLive.events)
        while (window.newerAfter != null) {
            val next = window.newerAfter!!.toInt()
            window = window.newer(EventPage(rows(next + 1, minOf(next + 200, 10_001)), true,
                after = if (next + 200 < 10_001) (next + 200).toLong() else null))
        }
        assertEquals(10_001L, window.events.last().seq)
    }
    @Test fun resyncDoesNotSpliceAcrossHistoryGapOrDropVisibleReader() {
        val window = ReadingWindow().seed(EventPage(rows(1, 200), false))
        val tail = Transcript().tail(EventPage(rows(4_001, 4_200), true))
        val frozen = window.live(tail, false)
        assertSame(window.events, frozen.events)
        assertEquals(200L, frozen.newerAfter)
        assertEquals(4_001L, window.live(tail, true).events.first().seq)
    }
    @Test fun duplicateBoundaryAndAroundAnchorArePreserved() {
        val window = ReadingWindow().seed(EventPage(rows(201, 400), true, 400, 201, RecordAnchor("event", "r", 280)))
        val older = window.older(EventPage(rows(1, 201), false))
        assertEquals(400, older.events.size)
        assertFalse(older.hasOlder)
        assertEquals(400L, older.newerAfter)
        assertSame(older, older.live(Transcript().tail(EventPage(rows(401, 600))), false))
    }
    @Test fun fullWindowStaysFrozenWhenNewEventsArriveDuringReading() {
        val window = ReadingWindow().seed(EventPage(rows(1, ReadingWindow.LIMIT)))
        val next = window.live(Transcript().tail(EventPage(rows(1, ReadingWindow.LIMIT + 1))), false)
        assertSame(window.events, next.events)
        assertEquals(ReadingWindow.LIMIT.toLong(), next.newerAfter)
    }
}
