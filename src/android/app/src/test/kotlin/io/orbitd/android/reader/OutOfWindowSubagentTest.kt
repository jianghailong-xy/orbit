package io.orbitd.android.reader

import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.core.realtime.RunEvent
import org.junit.Assert.*
import org.junit.Test

/**
 * A tail page that starts in the middle of a long workflow (web Transcript.backgroundTasks.test.tsx, "keeps an agent whose call is
 * older than the loaded window inside a card"): neither the Workflow call nor its agent's call is loaded, only what the agent did since
 * and the result the runner relays. Drawn at the top level, the agent's words read as the session's own and its result as a raw
 * "Tool output" row.
 */
class OutOfWindowSubagentTest {
    private fun event(seq: Long, type: String, payload: String) = RunEvent(type, seq, Wire.json.parseToJsonElement(payload))
    private val key = "toolu_wf:workflow-agent:a1"

    @Test fun aWorkflowAgentWhoseCallsAreNotLoadedStaysInCards() {
        val rows = transcriptRows(listOf(
            event(901, "assistant", """{"text":"Composing the verdict.","parentToolUseId":"$key"}"""),
            event(902, "tool_use", """{"id":"so","name":"Bash","input":{"command":"cat notes.md"},"parentToolUseId":"$key"}"""),
            event(903, "tool_result", """{"toolUseId":"so","content":"notes","parentToolUseId":"$key"}"""),
            event(904, "tool_result", """{"toolUseId":"$key","content":"{\"claim_held\":false}","parentToolUseId":"toolu_wf"}"""),
        ))
        val workflow = rows.single()
        assertEquals("tool_use", workflow.event.type)
        assertEquals("Workflow", workflow.event.fields.string("name"))
        val agent = workflow.children.single()
        assertEquals("Agent", agent.event.fields.string("name"))
        assertEquals(key, agent.event.toolId())
        assertEquals(904L, agent.result?.seq)
        assertEquals(listOf("assistant", "tool_use"), agent.children.map { it.event.type })
        assertEquals(903L, agent.children[1].result?.seq)
        assertTrue("every event is still found under the rows (find, jump)", (901L..904L).all(workflow::contains))
    }

    @Test fun anAgentsWorkWhoseCallIsNotLoadedNestsUnderAStandIn() {
        val rows = transcriptRows(listOf(
            event(1, "assistant", """{"text":"Reading the repo.","parentToolUseId":"toolu_agent"}"""),
            event(2, "tool_result", """{"toolUseId":"toolu_agent","content":"Done."}"""),
            event(3, "assistant", """{"text":"Both are back."}"""),
        ))
        assertEquals(listOf("tool_use", "assistant"), rows.map { it.event.type })
        assertEquals("Agent", rows[0].event.fields.string("name"))
        assertEquals(2L, rows[0].result?.seq)
        assertEquals("Reading the repo.", rows[0].children.single().event.body())
    }

    @Test fun aLoadedCallNeedsNoStandIn() {
        val rows = transcriptRows(listOf(
            event(1, "tool_use", """{"id":"toolu_agent","name":"Agent","input":{"description":"Deep-read"}}"""),
            event(2, "assistant", """{"text":"Reading the repo.","parentToolUseId":"toolu_agent"}"""),
            event(3, "tool_result", """{"toolUseId":"toolu_agent","content":"Done."}"""),
        ))
        assertEquals(1L, rows.single().event.seq)
        assertEquals(1, rows.single().children.size)
    }
}
