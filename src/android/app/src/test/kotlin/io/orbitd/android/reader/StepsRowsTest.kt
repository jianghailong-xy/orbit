package io.orbitd.android.reader

import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.core.realtime.RunEvent
import kotlinx.serialization.builtins.serializer
import org.junit.Assert.*
import org.junit.Test

/**
 * The steps line (web `stepsSummary` / `groupToolRuns`, Transcript.test.tsx's "steps line" cases): what folds into it, and the
 * words it says.
 */
class StepsRowsTest {
    private fun event(seq: Long, type: String, payload: String = "{}") = RunEvent(type, seq, Wire.json.parseToJsonElement(payload))
    private fun think(seq: Long, ms: Long) = event(seq, "thinking", """{"text":"look first","thinkingMs":$ms}""")
    private fun bash(seq: Long, command: String, description: String? = null) = event(seq, "tool_use",
        """{"id":"t$seq","name":"Bash","input":{"command":${Wire.json.encodeToString(String.serializer(), command)}${
            description?.let { ""","description":"$it"""" }.orEmpty()}}}""")
    private fun call(seq: Long, name: String, input: String = "{}") = event(seq, "tool_use", """{"id":"t$seq","name":"$name","input":$input}""")
    private fun done(seq: Long, of: Long, error: Boolean = false) =
        event(seq, "tool_result", """{"toolUseId":"t$of","content":"ok"${if (error) ""","isError":true""" else ""}}""")
    private fun say(seq: Long) = event(seq, "assistant", """{"text":"Containers are up."}""")
    private fun steps(vararg events: RunEvent) = Steps.group(transcriptRows(events.toList()))

    @Test fun aStretchOfWorkIsOneSentenceThinkingFirst() {
        val rows = steps(think(1, 15_000), bash(2, "ls /root/orbit/deploy"), done(3, 2), bash(4, "docker compose ps"), done(5, 4), say(6))
        assertEquals(listOf("thinking", "assistant"), rows.map { it.event.type })
        assertEquals(3, rows[0].steps.size)
        assertEquals("Thought for 15s, listed 1 directory, ran 1 shell command", Steps.summary(rows[0].steps))
        assertTrue("the steps row covers its calls' results", rows[0].contains(5))
        assertEquals(5L, rows[0].newestSeq)
    }

    @Test fun aSingleCallFoldsTooSoEveryStretchReadsAlike() {
        val rows = steps(bash(1, "git status"), done(2, 1))
        assertEquals("Ran 1 shell command", Steps.summary(rows.single().steps))
    }

    @Test fun readsAndEditsCountFilesRatherThanCalls() {
        val rows = steps(call(1, "Read", """{"file_path":"/w/a.ts"}"""), done(2, 1),
            call(3, "Edit", """{"file_path":"/w/a.ts"}"""), done(4, 3), call(5, "Edit", """{"file_path":"/w/a.ts"}"""), done(6, 5),
            call(7, "Edit", """{"file_path":"/w/b.ts"}"""), done(8, 7), call(9, "Grep", """{"pattern":"x"}"""), done(10, 9),
            call(11, "mcp__orbit__task_get"), done(12, 11))
        assertEquals("Read 1 file, edited 2 files, searched 1 time, used 1 tool", Steps.summary(rows.single().steps))
    }

    @Test fun codexWrappedShellCallsAreReadThroughTheirShell() =
        assertEquals("Listed 1 directory", Steps.summary(steps(bash(1, """/bin/bash -lc "ls -la""""), done(2, 1)).single().steps))

    @Test fun aCardOfItsOwnEndsTheRun() {
        val rows = steps(bash(1, "pwd"), done(2, 1), call(3, "AskUserQuestion"), bash(4, "whoami"), done(5, 4))
        assertEquals(listOf(1, 0, 1), rows.map { it.steps.size })
        assertEquals("AskUserQuestion", rows[1].event.fields.string("name"))
    }

    @Test fun aReadersOwnShellCommandStaysOutOfTheFoldAndAPictureFolds() {
        val shell = event(1, "tool_use", """{"id":"shell-1","name":"Bash","input":{"command":"ls"}}""")
        val picture = event(3, "tool_result", """{"toolUseId":"t2","content":[{"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBORw0KGgo="}}]}""")
        val rows = steps(shell, call(2, "Read", """{"file_path":"/tmp/s.png"}"""), picture)
        assertEquals(listOf(0, 1), rows.map { it.steps.size })
    }

    @Test fun failuresAreCountedNotOpened() {
        val rows = steps(bash(1, "go build ./...", "Build runner"), done(2, 1, error = true), bash(3, "pwd"), done(4, 3))
        assertEquals(1, rows.single().steps.count(Steps::failed))
    }

    @Test fun aCallWithNoAnswerIsInFlightUntilItsTurnEnds() {
        val events = listOf(bash(1, "grep -rn url schema.prisma", "Show prisma datasource config"))
        val step = steps(*events.toTypedArray()).single().steps.single()
        assertTrue(Steps.inFlight(step, events))
        assertFalse(Steps.inFlight(step, events + event(2, "turn_end", """{"subtype":"interrupted"}""")))
        assertEquals("Show prisma datasource config", Steps.purpose(step.event))
        assertEquals("grep -rn url schema.prisma", Steps.command(step.event))
    }

    @Test fun anUndescribedCallIsNamedByItsCommandAlone() {
        val step = steps(bash(1, "orbit task get x")).single().steps.single()
        assertEquals("orbit task get x", Steps.purpose(step.event))
        assertNull(Steps.command(step.event))
    }
}
