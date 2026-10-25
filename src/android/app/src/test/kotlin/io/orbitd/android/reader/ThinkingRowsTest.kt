package io.orbitd.android.reader

import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.core.realtime.RunEvent
import org.junit.Assert.*
import org.junit.Test

/**
 * A06-11: the settled thinking row — what it says (OrbitKit ThinkingSummaryTests, case for case) and how a turn's blocks fold
 * into rows (TranscriptThinkingTests' folding cases).
 */
class ThinkingRowsTest {
    private fun event(seq: Long, type: String, payload: String = "{}") = RunEvent(type, seq, Wire.json.parseToJsonElement(payload))
    private fun settle(seq: Long, text: String, ms: Long? = null) =
        event(seq, "thinking", """{"text":"$text"${ms?.let { ""","thinkingMs":$it""" }.orEmpty()}}""")
    private fun toolCall(seq: Long) = event(seq, "tool_use", """{"id":"t$seq","name":"Bash","input":{"command":"nvidia-smi"}}""")
    private fun label(row: TranscriptRow) = ThinkingSummary.settledLabel(row.thinkingText().length, row.blocks, row.thinkingMs())

    @Test fun durationReadsAsSecondsUnderAMinuteAndMinutesPastIt() {
        assertEquals("12s", ThinkingSummary.duration(12.0))
        assertEquals("1m 47s", ThinkingSummary.duration(107.0))
        assertEquals("2m", ThinkingSummary.duration(120.0))
    }

    @Test fun durationNeverClaimsABlockTookNoTime() = assertEquals("1s", ThinkingSummary.duration(0.4))

    @Test fun sizeIsStatedInCharactersSinceReasoningIsAsOftenCJK() {
        assertEquals("445 chars", ThinkingSummary.size(445))
        assertEquals("2.3k chars", ThinkingSummary.size(2300))
        assertEquals("21k chars", ThinkingSummary.size(21_000))
    }

    @Test fun settledLabelStatesDurationBlocksAndSize() =
        assertEquals("Thought for 1m 47s · 3 blocks · 21k chars", ThinkingSummary.settledLabel(21_000, 3, 107_000))

    @Test fun settledLabelOmitsTheBlockCountWhenNothingWasFolded() =
        assertEquals("Thought for 4s · 2.3k chars", ThinkingSummary.settledLabel(2300, 1, 4200))

    @Test fun settledLabelStatesSizeAloneWhenTheRunnerStoredNoDuration() {
        // A block an older runner stored: size still answers "is opening this worth it", and no duration is guessed.
        assertEquals("Thought · 84 chars", ThinkingSummary.settledLabel(84, 1, null))
        assertEquals("Thought · 2 blocks · 84 chars", ThinkingSummary.settledLabel(84, 2, 0))
    }

    @Test fun adjacentBlocksFoldIntoOneRowThatCountsThemAndSumsTheirTime() {
        val rows = transcriptRows(listOf(settle(1, "first", 1000), settle(2, "second", 2500), settle(3, "third")))
        val row = rows.single()
        assertEquals("the row keeps the first block's identity", "event:1", row.key)
        assertEquals(3, row.blocks)
        assertEquals("first\n\nsecond\n\nthird", row.thinkingText())
        assertEquals(3500L, row.thinkingMs())
        assertEquals("Thought for 4s · 3 blocks · 20 chars", label(row))
        assertTrue("the row covers through the last block it folded", row.contains(3))
        assertSame(row, anchorRow(rows, 2))
    }

    @Test fun aBlockEitherSideOfAToolCallKeepsItsOwnRow() {
        // Those two are not one thought: each explains the call it sits against.
        val rows = transcriptRows(listOf(settle(1, "why I am about to run this"), toolCall(2), settle(3, "what the output means")))
        assertEquals(listOf("thinking", "tool_use", "thinking"), rows.map { it.event.type })
        assertEquals(listOf(1, 1), rows.filter { it.event.type == "thinking" }.map { it.blocks })
    }

    @Test fun anEmptyBlockDrawsNoRowAndDoesNotPartTheBlocksAroundIt() {
        // A cold read of claude's transcript: every block closed empty, and nothing streamed on this device.
        assertTrue(transcriptRows(listOf(settle(1, ""), settle(2, ""))).isEmpty())
        val rows = transcriptRows(listOf(settle(1, "before"), settle(2, ""), settle(3, "after")))
        assertEquals(2, rows.single().blocks)
    }

    @Test fun aSubAgentsBlocksFoldInsideItsOwnRecords() {
        val rows = transcriptRows(listOf(event(1, "tool_use", """{"id":"agent","name":"Agent"}"""),
            event(2, "thinking", """{"text":"one","parentToolUseId":"agent"}"""),
            event(3, "thinking", """{"text":"two","parentToolUseId":"agent"}""")))
        assertEquals(2, rows.single().children.single().blocks)
    }

    @Test fun aRowWithoutAStoredDurationSaysItsSize() =
        assertEquals("Thought · 84 chars", label(transcriptRows(listOf(settle(1, "x".repeat(84)))).single()))
}
