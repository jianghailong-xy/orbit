package io.orbitd.android.core.realtime

import org.junit.Assert.*
import org.junit.Test

/** The engine's guess at the next message, as the transcript keeps it (docs/prompt-suggestions-design.md §3.4). */
class PromptSuggestionTest {
    private fun event(seq: Long, type: String, payload: String = "{}") =
        RunEvent.decode(SseFrame("""{"seq":$seq,"type":"$type","turnId":"turn-1","payload":$payload}""", null, null))

    private fun fold(vararg events: RunEvent) = events.fold(Transcript()) { t, e -> t.apply(e) }

    private val turn = arrayOf(
        event(1, "user", """{"text":"fix the flaky socket test"}"""),
        event(2, "assistant", """{"text":"Fixed."}"""),
        event(3, "turn_end", """{"subtype":"success"}"""),
    )

    @Test fun theSuggestionAfterATurnIsOffered() {
        val t = fold(*turn, event(4, "prompt_suggestion", """{"text":"  run the tests ","source":"engine"}"""))
        assertEquals("run the tests", t.promptSuggestion)
    }

    @Test fun anythingSaidAfterItTakesItAway() {
        val suggested = arrayOf(*turn, event(4, "prompt_suggestion", """{"text":"run the tests"}"""))
        assertNull("a message from any device", fold(*suggested, event(5, "user", """{"text":"ship it"}""")).promptSuggestion)
        assertNull("a newer turn ending", fold(*suggested, event(5, "turn_end")).promptSuggestion)
        assertEquals("events that say nothing about turns leave it", "run the tests",
            fold(*suggested, event(5, "system", """{"subtype":"status"}""")).promptSuggestion)
    }

    @Test fun nothingIsOfferedWithoutOne() {
        assertNull(fold(*turn).promptSuggestion)
        assertNull(fold(*turn, event(4, "prompt_suggestion", """{"text":"   "}""")).promptSuggestion)
        assertTrue("it is durable, so a reload replays it", event(4, "prompt_suggestion").durable)
    }
}
