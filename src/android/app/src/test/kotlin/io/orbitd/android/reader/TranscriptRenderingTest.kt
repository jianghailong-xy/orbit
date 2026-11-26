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
    @Test fun legacySecretPatchNoticesFoldOnlyConsecutiveTemporaryNotices() {
        val pending = "Orbit is still checking this runner's checkouts for a secret the owner removed, so it left this diff out of what it reports for now. Nothing in the file is known to hold a secret; its diff shows again with the session's next report."
        val unreadable = "Orbit could not read its record of files that held a secret's value on this runner, so it left this diff out of what it reports. Nothing in the file is known to hold a secret."
        fun notice(seq: Long, text: String, subtype: String = "secret_patch_withheld", turn: String = "one") =
            RunEvent("system", seq, buildJsonObject {
                put("subtype", subtype); put("path", "file"); put("notice", text)
            }, turnId = turn)
        val rows = transcriptRows(listOf(
            notice(1, "file: $pending"), notice(2, "file: $unreadable"),
            notice(3, "file holds the value of a secret"), notice(4, "Unknown notice"),
            notice(5, "Record summary", "secret_patches_withheld"),
            notice(6, "file: $pending"), notice(7, "file: $pending", turn = "two")
        ))
        assertEquals(listOf(
            "Orbit held back the diffs of 2 files while it checked this runner for a removed secret. No secret was found in them.",
            "file holds the value of a secret", "Unknown notice", "Record summary",
            "Orbit held back the diff of 1 file while it checked this runner for a removed secret. No secret was found in it.",
            "Orbit held back the diff of 1 file while it checked this runner for a removed secret. No secret was found in it."
        ), rows.map { it.event.body() })
    }

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
        // The call it nests under stands in for the one outside the page (OutOfWindowSubagentTest), and keeps the child's place.
        assertEquals("outside", rows.single().event.toolId())
        assertEquals("Keep this result", rows.single().children.single().result!!.body())
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
    @Test fun aGuestReadsAnAttachmentThroughTheGuestDoor() {
        val id = "01a0cca7-8609-70ed-a0e2-d4b55b832b60"
        val attachment = "01a0cca7-8609-70ed-a0e2-d4b55b832b61"
        assertEquals(listOf("attachments", attachment), resourceRequest("orbit-attachment:$attachment", null)!!.path)
        assertEquals(listOf("guest-sessions", "34A", "attachments", attachment),
            resourceRequest("orbit-attachment:$attachment", null, guestSessionId = "34A")!!.path)
        // A guest has no artifact route: a worktree path stays words.
        assertNull(resourceRequest("/root/.orbit/worktrees/$id/x.png", null, guestSessionId = id))
    }
}
