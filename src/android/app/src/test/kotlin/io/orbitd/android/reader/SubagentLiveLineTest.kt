package io.orbitd.android.reader

import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.core.realtime.RunEvent
import org.junit.Assert.*
import org.junit.Test

/**
 * A06-17: what a folded, still-running background task's card says its sub-agent is on (iOS ea175e5af `liveActivity`, web
 * `SubagentLiveLine`): the last record nested under the call that says something, through Android's approximation of OrbitKit's
 * `ToolDisplay` (label, file, summary).
 */
class SubagentLiveLineTest {
    private fun event(seq: Long, type: String, payload: String) = RunEvent(type, seq, Wire.json.parseToJsonElement(payload))
    private fun agent(vararg children: RunEvent) =
        transcriptRows(listOf(event(1, "tool_use", """{"id":"agent","name":"Agent","input":{"description":"Survey"}}""")) + children).single()
    private fun line(vararg children: RunEvent) = SubagentLiveLine.of(agent(*children).children)
    private fun call(seq: Long, name: String, input: String) = event(seq, "tool_use", """{"id":"c$seq","name":"$name","input":$input,"parentToolUseId":"agent"}""")

    @Test fun aToolCallReadsAsItsLabelAndTheFileItTouched() {
        assertEquals("Read TailPinning.kt", line(call(2, "Read", """{"file_path":"/repo/src/android/app/TailPinning.kt","offset":10}""")))
        assertEquals("Edit SessionReader.kt", line(call(2, "Edit", """{"file_path":"src/SessionReader.kt","old_string":"a","new_string":"b"}""")))
        assertEquals("apply_patch README.md", line(call(2, "apply_patch", """{"files":["/repo/README.md","/repo/b.md"]}""")))
    }

    @Test fun aToolCallWithoutAFileReadsAsItsLabelAndWhatItDid() {
        assertEquals("Bash Run the reader's tests", line(call(2, "Bash", """{"command":"gradle test","description":"Run the reader's tests"}""")))
        assertEquals("Bash git status --short", line(call(2, "Bash", """{"command":"git   status\n --short"}""")))
        assertEquals("Grep thinkingMs  ·  src", line(call(2, "Grep", """{"pattern":"thinkingMs","path":"src"}""")))
        assertEquals("Glob **/*.kt", line(call(2, "Glob", """{"pattern":"**/*.kt"}""")))
        assertEquals("WebFetch https://example.test", line(call(2, "WebFetch", """{"url":"https://example.test"}""")))
        assertEquals("Agent · Explore Find the fold", line(call(2, "Agent", """{"subagent_type":"Explore","description":"Find the fold"}""")))
        assertEquals("orbit · task_get taskId: 34g6", line(call(2, "mcp__orbit__task_get", """{"taskId":"34g6"}""")))
        assertEquals("Todos", line(call(2, "TodoWrite", """{"todos":[]}""")))
    }

    @Test fun reasoningReadsAsThinkingAndAReplyAsItsFirstLine() {
        assertEquals("Thinking…", line(call(2, "Read", """{"file_path":"a.kt"}"""), event(3, "thinking", """{"text":"hmm","parentToolUseId":"agent"}""")))
        assertEquals("Found two callers.", line(event(2, "assistant", """{"text":"\n  \nFound two callers.\nThe first…","parentToolUseId":"agent"}""")))
    }

    @Test fun recordsThatSayNothingArePassedOverForTheOneBefore() {
        // An empty reply, and a provider error inside the sub-agent (drawn as an error row), say nothing about what it is on.
        assertEquals("Read a.kt", line(call(2, "Read", """{"file_path":"a.kt"}"""),
            event(3, "assistant", """{"text":"  ","parentToolUseId":"agent"}"""),
            event(4, "assistant", """{"text":"API Error: 529 overloaded","parentToolUseId":"agent"}""")))
        assertNull("no record yet: the progress line keeps its place", line())
    }
}
