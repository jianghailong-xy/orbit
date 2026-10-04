package io.orbitd.android.reader

import io.orbitd.android.core.realtime.RunEvent
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.navigation.*
import io.orbitd.android.text.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import org.commonmark.node.*
import org.commonmark.ext.gfm.tables.*

class TranscriptRenderingTest {
    @Test fun giantSingleLineOutputHasBoundedSurrogateSafeDisplayChunks() {
        val source = "😀x".repeat(180_000)
        val chunks = io.orbitd.android.text.outputChunks(source)
        assertEquals(source, chunks.joinToString("").replace("\n", ""))
        assertTrue(chunks.all { it.lines().size <= 32 && it.lines().all { line -> line.length <= 2_048 && !line.last().isHighSurrogate() } })
    }
    private fun event(seq: Long, type: String, payload: String) = RunEvent(type, seq, Wire.json.parseToJsonElement(payload))
    @Test fun childToolResultSurvivesWhenParentIsOutsideThePage() {
        val rows = transcriptRows(listOf(event(10, "tool_use", """{"id":"child","parentToolUseId":"outside"}"""),
            event(11, "tool_result", """{"tool_use_id":"child","parentToolUseId":"outside","content":"Keep this result"}""")))
        assertEquals(1, rows.size)
        assertEquals("Keep this result", rows.single().result!!.body())
        assertEquals("event:10", anchorRow(rows, 11)!!.key)
    }
    @Test fun toolsAndSubagentsKeepResultAnchorsAndOrphanResults() {
        val events = listOf(event(1, "tool_use", """{"id":"agent","name":"Task"}"""),
            event(2, "assistant", """{"text":"Child","parentToolUseId":"agent"}"""),
            event(3, "tool_use", """{"id":"nested","name":"Read","parentToolUseId":"agent"}"""),
            event(4, "tool_result", """{"toolUseId":"nested","content":"nested output","parentToolUseId":"agent"}"""),
            event(5, "tool_result", """{"toolUseId":"agent","content":"parent output"}"""),
            event(6, "tool_result", """{"toolUseId":"outside-window","content":"orphan output"}"""))
        val rows = transcriptRows(events)
        assertEquals(2, rows.size)
        assertEquals(2, rows.first().children.size)
        assertEquals("parent output", rows.first().result!!.body())
        assertEquals("event:1", anchorRow(rows, 4)!!.key)
        assertEquals("event:6", anchorRow(rows, 7)!!.key)
    }
    @Test fun mcpWrapperAndImagesAreReadWithoutPrintingBase64() {
        val value = Wire.json.parseToJsonElement("""{"content":[{"type":"text","text":"useful output"},{"type":"image","mimeType":"image/png","data":"YQ=="}]}""")
        assertEquals("useful output", contentText(value))
        assertEquals(listOf("data:image/png;base64,YQ=="), contentImages(value))
    }
    @Test fun streamingFenceNeverReflowsUnclosedBlockAndDropsNoText() {
        val source = "完成段落\n\n~~~~kotlin\nval x = 1\n\n```\n"
        val split = streamingSplit(source)
        assertEquals("完成段落\n\n", split.first)
        assertEquals(source, split.first + split.second)
    }
    @Test fun commonMarkParsesGfmTableCodeAndTaskListWithChinese() {
        val source = "# 中文\n\n| A | B |\n| :- | -: |\n| **bold** | \\| |\n\n- [x] done\n\n~~~diff\n-old\n+new\n~~~\n\n![image](orbit-attachment:123)"
        val children = markdownParser.parse(source).children()
        assertTrue(children.any { it is TableBlock })
        assertTrue(children.any { it is FencedCodeBlock && it.info == "diff" })
        assertTrue(children.any { it is BulletList })
    }
    @Test fun recordLinksAndArtifactPathsStayWithinSession() {
        val id = "01a0cca7-8609-70ed-a0e2-d4b55b832b60"
        val record = "01a0cca7-8609-70ed-a0e2-d4b55b832b61"
        assertEquals(record, OrbitLinks.parse("orbit-session:$id?at=$record")!!.recordId)
        assertEquals(record, OrbitLinks.parse("https://orbit.test/sessions/$id?at=$record", "https://orbit.test")!!.recordId)
        assertNotNull(resourceRequest("/root/.orbit/worktrees/$id/src/a.kt:4:2", id))
        assertNull(resourceRequest("/root/.orbit/worktrees/$record/x.png", id))
        assertNull(resourceRequest("/root/.orbit/worktrees/$id/../private", id))
        assertNull(resourceRequest("file:///etc/passwd", id))
        assertNull(resourceRequest("https://elsewhere.test/image.png", id))
    }
}
