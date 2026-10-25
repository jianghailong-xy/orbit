package io.orbitd.android.reader

import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.core.realtime.RunEvent
import org.junit.Assert.*
import org.junit.Test

/**
 * A06-4 (iOS 61cc028ec): the sticky question header's hold, against the geometry that froze the iPhone
 * app, case for case with OrbitKit's StickyQuestionHoldTests — and `StickyQuestions.name`, the one place
 * the header asks it.
 */
class StickyQuestionHoldTest {
    /** One settle under the fallback rule: run until the header's state stops changing, or report that it never does. */
    private fun settle(from: Boolean, offsetWith: (Boolean) -> Double, passes: Int = 12): Pair<Boolean, Int> {
        var showing = from
        repeat(passes) { pass ->
            val next = StickyQuestionHold.fallbackNames(offsetWith(showing), showing)
            if (next == showing) return showing to pass
            showing = next
        }
        return showing to passes
    }

    @Test fun theGeometryThatFrozeThePhoneSettlesInsteadOfFlipping() {
        val measured = { showing: Boolean -> if (showing) -66.0 else 81.0 }
        val (fromShown, passes) = settle(true, measured)
        assertFalse("the header hides, and stays hidden", fromShown)
        assertTrue("one change, then still", passes <= 1)
        val (fromHidden, still) = settle(false, measured)
        assertFalse(fromHidden)
        assertEquals("a hidden header is not shown by the reading its own absence produced", 0, still)
    }

    @Test fun anyMoveTheHeaderMakesByItselfSettles() {
        assertTrue(StickyQuestionHold.FALLBACK_SHOW_AFTER - StickyQuestionHold.FALLBACK_HIDE_AT > 147 * 2)
        var hidden = -200.0
        while (hidden <= 1200) {
            for (move in listOf(32.0, 147.0, 200.0)) for (start in listOf(true, false)) {
                val offset = hidden
                assertTrue("flips forever at $offset, move $move", settle(start, { if (it) offset - move else offset }).second < 12)
            }
            hidden += 7
        }
    }

    @Test fun aLongTranscriptStillShowsItsQuestionAtOnceAndHidesAtTheTop() {
        assertTrue(StickyQuestionHold.fallbackNames(2400.0, false))
        assertTrue(StickyQuestionHold.fallbackNames(2400.0, true))
        assertTrue("shown, it stays until the list is back at its top", StickyQuestionHold.fallbackNames(120.0, true))
        assertFalse(StickyQuestionHold.fallbackNames(40.0, true))
        assertFalse(StickyQuestionHold.fallbackNames(0.0, false))
        assertFalse("hidden, a short scroll does not raise it", StickyQuestionHold.fallbackNames(120.0, false))
    }

    @Test fun theNamedQuestionUnderTheTopLineKeepsItsHeader() {
        assertEquals("q1", StickyQuestionHold.named(null, "q1", "q1"))
        assertNull("a row above the question at the line: nothing is above the fold", StickyQuestionHold.named(null, "a0", "q1"))
        assertEquals("an earlier question takes over as before", "q1", StickyQuestionHold.named("q1", "q2", "q2"))
        assertEquals("q1", StickyQuestionHold.named("q1", "r1", null))
        assertNull("hidden, a question at the line does not raise the header", StickyQuestionHold.named(null, "q1", null))
        // The two frames that used to alternate: shown, the question is at the line; hidden, its reply.
        var stuck: String? = "q1"
        repeat(6) {
            val anchor = if (stuck == null) "r1" else "q1"
            stuck = StickyQuestionHold.named(if (anchor == "r1") "q1" else null, anchor, stuck)
            assertEquals("the header holds instead of flipping", "q1", stuck)
        }
    }

    private fun event(seq: Long, type: String, payload: String) = RunEvent(type, seq, Wire.json.parseToJsonElement(payload))

    /** The header's one question to `StickyQuestions.name`, for the same alternating frames over real rows. */
    @Test fun nameAsksTheHoldForBothAnswers() {
        val rows = transcriptRows(listOf(event(1, "assistant", """{"text":"before"}"""), event(2, "user", """{"text":"Q1"}"""),
            event(3, "assistant", """{"text":"reply"}""")))
        val questions = StickyQuestions(rows)
        assertEquals("event:2", questions.name("event:3", 0.0, null))
        assertNull(questions.name("event:2", 0.0, null))
        assertEquals("the question straddling the line keeps the header it named", "event:2", questions.name("event:2", 0.0, "event:2"))
        assertNull("above the first row nothing is named", questions.name("older", 5000.0, "event:2"))
        assertEquals("below the last row every question is above", "event:2", questions.name("interaction-cards", 0.0, null))
        assertNull("no row claimed the line, hidden and a short scroll", questions.name(null, 120.0, null))
        assertEquals("…shown, it stays", "event:2", questions.name(null, 120.0, "event:2"))
        assertEquals("…far down, it shows at once", "event:2", questions.name(null, 2400.0, null))
        var stuck: String? = "event:2"
        repeat(6) { stuck = questions.name(if (stuck == null) "event:3" else "event:2", 0.0, stuck); assertEquals("event:2", stuck) }
    }
}
