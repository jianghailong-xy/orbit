package io.orbitd.android.core.realtime

import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.*
import org.junit.Test

/**
 * A06-11: what the live transcript keeps of a stretch of reasoning once its durable block lands (iOS 471b2afbb and d55e9900b;
 * OrbitKit TranscriptThinkingTests, web thinkingDraft.test.ts). Claude closes every block with `{"thinking":"","signature":…}`, so
 * the words only ever arrive as `thinking_delta`: the device keeps them on its local copy of the block.
 */
class TranscriptThinkingTest {
    private fun event(seq: Long, type: String, payload: String = "{}") =
        RunEvent.decode(SseFrame("""{"seq":$seq,"type":"$type","payload":$payload}""", null, null))
    private fun delta(text: String, parent: String? = null) =
        event(0, "thinking_delta", """{"delta":${JsonPrimitive(text)}${parent?.let { ""","parentToolUseId":"$it"""" }.orEmpty()}}""")
    private fun Transcript.text(seq: Long) = events.single { it.seq == seq }.fields.text("text")

    @Test fun streamedReasoningSurvivesABlockThatClosesEmpty() {
        val t = Transcript().apply(event(1, "user", """{"text":"go"}"""))
            .apply(delta("weighing whether ")).apply(delta("to go straight to L3"))
            .apply(event(2, "thinking", """{"text":"","thinkingMs":4200}"""))
        assertEquals("weighing whether to go straight to L3", t.text(2))
        assertEquals("the runner's duration rides along untouched", 4200L, t.events.single { it.seq == 2L }.fields.number("thinkingMs"))
        assertTrue("the draft is spent", t.thinkingDrafts.isEmpty())
    }

    @Test fun aBlockWithWordsOfItsOwnKeepsThem() {
        // A provider that reported its reasoning is the authority on it; the draft may already hold the next block's first words.
        val t = Transcript().apply(delta("streamed")).apply(event(2, "thinking", """{"text":"the provider's own words"}"""))
        assertEquals("the provider's own words", t.text(2))
    }

    @Test fun anEmptyBlockWithNothingStreamedStaysEmpty() {
        // A cold read replays durable events with no deltas behind them: nothing is invented, and the reader draws no row.
        assertEquals("", Transcript().apply(event(2, "thinking", """{"text":""}""")).text(2))
    }

    @Test fun aLateBlockTakesNothingFromTheStretchStreamingNow() {
        val t = Transcript().apply(event(5, "assistant", """{"text":"newer"}""")).apply(delta("the next stretch"))
            .apply(event(3, "thinking", """{"text":""}"""))
        assertEquals("", t.text(3))
        assertEquals("the next stretch", t.thinkingDrafts[""])
    }

    @Test fun aSubAgentsBlockTakesItsOwnStretchOnly() {
        val t = Transcript().apply(delta("parent's")).apply(delta("child's", parent = "toolu_agent"))
            .apply(event(2, "thinking", """{"text":"","parentToolUseId":"toolu_agent"}"""))
        assertEquals("child's", t.text(2))
        assertEquals("parent's", t.thinkingDrafts[""])
    }

    @Test fun aReconnectsOverlapKeepsTheWordsThisDeviceStreamed() {
        // The REST overlap replayed on every reconnect carries the server's empty copy; this device's copy keeps its words.
        val live = Transcript().apply(delta("kept")).apply(event(2, "thinking", """{"text":""}"""))
        val replayed = live.page(EventPage(listOf(event(2, "thinking", """{"text":""}"""), event(3, "assistant", """{"text":"after"}"""))))
        assertEquals("kept", replayed.text(2))
        assertEquals(listOf(2L, 3L), replayed.events.map { it.seq })
        // A transcript read cold has no copy of its own to keep.
        assertEquals("", Transcript().tail(EventPage(listOf(event(2, "thinking", """{"text":""}""")))).text(2))
    }

    @Test fun noDurationIsGuessedForABlockTheRunnerDidNotTime() {
        // An older runner stores no `thinkingMs`. The device does not stand in with its own clock (see ThinkingSummary): the row
        // states its size alone rather than a duration a reconnect's replayed prefix would have shortened.
        val t = Transcript().apply(delta("a while")).apply(event(2, "thinking", """{"text":""}"""))
        assertNull(t.events.single { it.seq == 2L }.fields.number("thinkingMs"))
    }
}
