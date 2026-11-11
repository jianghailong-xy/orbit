package io.orbitd.android.reader

import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.core.realtime.RunEvent
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

/** The head row of each turn (web `Transcript.turnHead.test.tsx`): which messages open one, what ends it, and what it says. */
class TurnHeadsTest {
    private fun ts(second: Int) = "2026-11-11T10:%02d:%02dZ".format(second / 60, second % 60)
    private fun event(seq: Long, type: String, second: Int, payload: String = "{}") =
        RunEvent(type, seq, Wire.json.parseToJsonElement(payload), ts = ts(second))
    private fun user(seq: Long, second: Int, extra: String = "") = event(seq, "user", second, """{"text":"go"$extra}""")
    private fun end(seq: Long, second: Int, subtype: String = "success") = event(seq, "turn_end", second, """{"subtype":"$subtype"}""")
    private fun reply(seq: Long, second: Int) = event(seq, "assistant", second, """{"text":"done"}""")
    private fun at(second: Int) = Instant.parse(ts(second)).toEpochMilli()

    @Test fun anEndedTurnSaysHowLongItWorked() {
        val heads = TurnHeads.of(listOf(user(1, 0), reply(2, 30), end(3, 72)))
        assertEquals(setOf(1L), heads.keys)
        assertEquals("Worked for 1m 12s", TurnHeads.label(heads.getValue(1), ticking = false, nowMs = at(999)))
        assertEquals("Worked for 1m 12s", TurnHeads.label(heads.getValue(1), ticking = true, nowMs = at(999)))
    }

    @Test fun theNewestOpenTurnOfALiveSessionCountsUpFromItsStart() {
        val head = TurnHeads.of(listOf(user(1, 0), reply(2, 5))).getValue(1)
        assertEquals("Working for 12s", TurnHeads.label(head, ticking = true, nowMs = at(12)))
        assertEquals("Working for 13s", TurnHeads.label(head, ticking = true, nowMs = at(13)))
    }

    @Test fun anOpenTurnThatIsNotTickingSaysNothing() {
        // Not live, or an older head whose turn_end lies beyond the window: no running clock, and no guess.
        val heads = TurnHeads.of(listOf(user(1, 0), reply(2, 5), user(3, 60), end(4, 90)))
        assertNull(TurnHeads.label(heads.getValue(1), ticking = false, nowMs = at(120)))
        assertEquals("Worked for 30s", TurnHeads.label(heads.getValue(3), ticking = false, nowMs = at(120)))
    }

    @Test fun aSteerJoinsTheTurnInsteadOfOpeningOne() {
        val heads = TurnHeads.of(listOf(user(1, 0), user(2, 10, ""","steer":true"""), end(3, 20)))
        assertEquals(setOf(1L), heads.keys)
        assertEquals("Worked for 20s", TurnHeads.label(heads.getValue(1), ticking = false, nowMs = 0))
    }

    @Test fun aSteerHandedBackAndReDeliveredAsAMessageOpensATurn() {
        val heads = TurnHeads.of(listOf(user(1, 0), user(2, 10, ""","steer":true,"delivery":"requeued""""), end(3, 20),
            event(4, "user", 21, """{"text":"go","delivery":"written"}"""), end(5, 30)))
        assertEquals(setOf(1L, 4L), heads.keys)
        assertEquals("Worked for 9s", TurnHeads.label(heads.getValue(4), ticking = false, nowMs = 0))
    }

    @Test fun aSubAgentsMessageOpensNoTurn() {
        val heads = TurnHeads.of(listOf(user(1, 0), user(2, 5, ""","parentToolUseId":"toolu_1""""), end(3, 40)))
        assertEquals(setOf(1L), heads.keys)
        assertEquals("Worked for 40s", TurnHeads.label(heads.getValue(1), ticking = false, nowMs = 0))
    }

    @Test fun aFailedTurnStillEnds() {
        val head = TurnHeads.of(listOf(user(1, 0), end(2, 8, subtype = "error_during_execution"))).getValue(1)
        assertEquals("Worked for 8s", TurnHeads.label(head, ticking = true, nowMs = at(500)))
    }

    @Test fun anOlderPagePrependedJoinsAHeadToItsEnd() {
        // The first page starts mid-turn: its turn_end has no head to close, and the open head is the newest turn's.
        val tail = listOf(reply(5, 50), end(6, 61), user(7, 70))
        assertEquals(setOf(7L), TurnHeads.of(tail).keys)
        val joined = TurnHeads.of(listOf(user(3, 1), reply(4, 20)) + tail)
        assertEquals("Worked for 1m", TurnHeads.label(joined.getValue(3), ticking = false, nowMs = 0))
        assertNull(TurnHeads.label(joined.getValue(7), ticking = false, nowMs = 0))
        assertEquals("Working for 5s", TurnHeads.label(joined.getValue(7), ticking = true, nowMs = at(75)))
    }

    @Test fun aStartWithNoStampSaysWorkingOnlyWhileLive() {
        val head = TurnHead(start = null, end = null, closed = false)
        assertEquals("Working…", TurnHeads.label(head, ticking = true, nowMs = 0))
        assertNull(TurnHeads.label(head, ticking = false, nowMs = 0))
        assertNull(TurnHeads.label(TurnHead(start = null, end = ts(5), closed = true), ticking = true, nowMs = 0))
    }

    @Test fun aTurnIsNeverUnderASecond() {
        val head = TurnHeads.of(listOf(user(1, 0), end(2, 0))).getValue(1)
        assertEquals("Worked for 1s", TurnHeads.label(head, ticking = false, nowMs = 0))
    }

    @Test fun spanReadsAsWebCheckDuration() {
        assertEquals("1s", TurnHeads.span(0))
        assertEquals("45s", TurnHeads.span(45_000))
        assertEquals("2m", TurnHeads.span(120_000))
        assertEquals("1m 12s", TurnHeads.span(72_400))
        assertEquals("1h", TurnHeads.span(3_600_000))
        assertEquals("1h 5m", TurnHeads.span(3_930_000))
    }
}
