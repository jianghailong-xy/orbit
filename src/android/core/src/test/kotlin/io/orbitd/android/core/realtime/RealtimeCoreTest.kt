package io.orbitd.android.core.realtime

import io.orbitd.android.core.protocol.ProtocolException
import io.orbitd.android.core.protocol.Wire
import java.io.File
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.*
import org.junit.Test

class RealtimeCoreTest {
    private fun event(seq: Long, type: String, payload: String = "{}") =
        RunEvent.decode(SseFrame("""{"seq":$seq,"type":"$type","payload":$payload}""", null, null))

    @Test fun sharedGoldenCases() {
        val file = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
            .map { File(it, "src/shared/src/realtime-recovery.fixture.json") }.first { it.exists() }
        val fixtures = Wire.json.parseToJsonElement(file.readText()).jsonObject["cases"]!!.jsonArray
        for (fixture in fixtures) {
            val test = fixture.jsonObject
            val expected = test["expected"]!!.jsonObject
            var transcript = Transcript()
            test["events"]!!.jsonArray.forEach { raw -> transcript = transcript.apply(
                Wire.decode(raw.toString().encodeToByteArray(), RunEvent.serializer())) }
            val messages = transcript.events.filter { it.type in setOf("user", "assistant") }
                .map { "${it.type}:${it.fields.text("text")}" }
            val tools = transcript.events.filter { it.type == "tool_result" }
                .map { "${it.fields.text("toolUseId")}:${it.fields.text("content")}" }
            assertEquals(test["name"].toString(), expected["maxSeq"]!!.jsonPrimitive.content.toLong(), transcript.maxSeq)
            assertEquals(expected["messages"]!!.jsonArray.map { it.jsonPrimitive.content }, messages)
            assertEquals(expected["tools"]!!.jsonArray.map { it.jsonPrimitive.content }, tools)
            assertEquals(expected["draft"]!!.jsonPrimitive.content, transcript.textDrafts[""].orEmpty())
        }
    }

    @Test fun bytesKeepUtf8BlankLinesBomCrLfMultilineAndIdRules() {
        val parser = SseParser()
        val frames = ("\uFEFF:keepalive\r\nid: good\revent: update\rdata: 中文🙂\rdata: next\r\r" +
            "id: bad\u0000id\ndata: end\n\nid:\n\ndata: last\n\n" + "data: incomplete")
            .encodeToByteArray().asIterable().mapNotNull(parser::consume)
        assertEquals(3, frames.size)
        assertEquals(SseFrame("中文🙂\nnext", "update", "good"), frames[0])
        assertEquals("good", frames[1].id)
        assertEquals("", frames[2].id)
        assertNull(frames[1].event)
    }

    @Test fun parserBoundsAnUnterminatedFrame() {
        val parser = SseParser(8)
        assertThrows(ProtocolException::class.java) { "data: too large".encodeToByteArray().forEach { parser.consume(it) } }
    }

    @Test fun livePositiveAndSentinelDoNotAdvanceAndUnknownDurableIsRetained() {
        var transcript = Transcript().apply(event(4, "assistant", """{"text":"done"}"""))
        for (type in listOf("text_delta", "thinking_delta", "tool_output", "background_output", "task_progress", "approval_request")) {
            transcript = transcript.apply(event(500, type))
        }
        transcript = transcript.apply(event(SENTINEL_SEQ, "status", """{"status":"SUCCEEDED"}"""))
        assertEquals(4, transcript.maxSeq)
        assertEquals(0, transcript.resumeSeq)
        transcript = transcript.apply(event(7, "future_kind"))
        assertEquals(7, transcript.maxSeq)
        assertEquals("future_kind", transcript.events.last().type)
    }

    @Test fun reorderedDurableEventsSortDedupAndDoNotDestroyNewDraft() {
        var transcript = Transcript().apply(event(10, "user", """{"text":"new"}"""))
            .apply(event(0, "text_delta", """{"text":"now"}"""))
        transcript = transcript.apply(event(7, "assistant", """{"text":"old"}"""))
            .apply(event(7, "assistant", """{"text":"duplicate"}"""))
        assertEquals(listOf(7L, 10L), transcript.events.map { it.seq })
        assertEquals("now", transcript.textDrafts[""])
        assertEquals(0, transcript.resumeSeq)
    }

    @Test fun reconnectClearsAnimationAndTailResyncReplacesWholeWindow() {
        var transcript = Transcript().tail(EventPage(listOf(event(5, "user")), true))
            .apply(event(0, "text_delta", """{"text":"prefix"}"""))
        transcript = transcript.withoutLive().apply(event(0, "text_delta", """{"text":"prefix plus"}"""))
        assertEquals("prefix plus", transcript.textDrafts[""])
        assertEquals(5, transcript.resumeSeq)
        transcript = transcript.tail(EventPage(listOf(event(2000, "assistant", """{"text":"tail"}""")), true))
        assertEquals(listOf(2000L), transcript.events.map { it.seq })
        assertEquals(2000, transcript.resumeSeq)
        assertTrue(transcript.hasMore)
        assertTrue(transcript.textDrafts.isEmpty())
    }

    @Test fun emptyToolSnapshotClearsAndFinalResultSuppressesLateOutput() {
        var transcript = Transcript().apply(event(1, "tool_use", """{"toolUseId":"x"}"""))
        fun output(seq: Int, content: String) = event(900, "tool_output", """{"toolUseId":"x","snapshotSeq":$seq,"content":"$content"}""")
        transcript = transcript.apply(output(12, "new")).apply(output(11, "old")).apply(output(12, "duplicate"))
        assertEquals("new", transcript.toolOutputs["x"]?.text("content"))
        transcript = transcript.apply(output(13, ""))
        assertEquals("", transcript.toolOutputs["x"]?.text("content"))
        transcript = transcript.apply(event(2, "tool_result", """{"toolUseId":"x","content":"final"}""")).apply(output(14, "late"))
        assertFalse(transcript.toolOutputs.containsKey("x"))
    }

    @Test fun retryRampIsBoundedAndHealthResetsIt() {
        val policy = ReconnectPolicy { 1.0 }
        assertEquals(listOf(1000L, 2000L, 4000L, 8000L, 15000L, 15000L), (1..6).map { policy.delayMs(true) })
        policy.healthy()
        assertEquals(1000, policy.delayMs(true))
        assertEquals(300, policy.delayMs(false))
    }

    @Test fun lateResultAndTerminalSentinelBothRetireToolPreview() {
        val use = event(1, "tool_use", """{"toolUseId":"x"}""")
        val output = event(99, "tool_output", """{"toolUseId":"x","content":"live"}""")
        val newer = event(5, "assistant", """{"text":"newer"}""")
        val base = Transcript().apply(use).apply(output).apply(newer)
        assertFalse(base.apply(event(4, "tool_result", """{"toolUseId":"x","content":"done"}""")).toolOutputs.containsKey("x"))
        val finished = base.apply(event(SENTINEL_SEQ, "status", """{"status":"SUCCEEDED"}""")).apply(output)
        assertTrue(finished.toolOutputs.isEmpty())
        assertEquals(5, finished.maxSeq)
    }

}
