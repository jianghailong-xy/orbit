package io.orbitd.android.reader

import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.core.realtime.RunEvent
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/**
 * The engine's own reports in the transcript, case for case with OrbitKit's TranscriptReducerTests:
 * stderr as an error row (folded, joined, settling a tool's call), a notice or recoverable diagnostic
 * as a notice row (A06-1), and a reply or error event that is the provider failing as an error row or
 * an auto-retry row (A06-2).
 */
class EngineRowsTest {
    private fun event(seq: Long, type: String, payload: String = "{}") = RunEvent(type, seq, Wire.json.parseToJsonElement(payload))
    private fun stderr(seq: Long, line: String, extra: String = "") =
        event(seq, "system", """{"stderr":${JsonPrimitive(line)}${if (extra.isEmpty()) "" else ",$extra"}}""")
    private fun kinds(rows: List<TranscriptRow>) = rows.map { it.event.type to it.event.body() }

    @Test fun engineStderrBecomesAnErrorRow() {
        val rows = transcriptRows(listOf(event(1, "user", """{"text":"继续编辑"}"""),
            stderr(2, "--dangerously-skip-permissions cannot be used with root/sudo privileges\n")))
        assertEquals(listOf("user" to "继续编辑", "error" to "--dangerously-skip-permissions cannot be used with root/sudo privileges"), kinds(rows))
        assertEquals("event:2", rows.last().key)
    }

    @Test fun recoverableStructuredStderrBecomesANoticeRow() {
        val rows = transcriptRows(listOf(stderr(1, "2026-10-03T15:27:44.249024Z ERROR codex_models_manager::manager: failed to refresh available models: unexpected status 401 Unauthorized",
            """"diagnostic":{"component":"model_catalog","phase":"startup","severity":"WARN","impact":"degraded","recoverable":true,"code":"codex_model_catalog_auth"}""")))
        assertEquals("notice", rows.single().event.type)
        assertTrue(rows.single().event.body().startsWith("Startup · model_catalog · codex_model_catalog_auth:"))
    }

    @Test fun persistedLegacyRecoverableStderrBecomesANoticeRow() {
        val rows = transcriptRows(listOf(stderr(1, "2026-10-03T15:27:44.249024Z ERROR codex_models_manager::manager: failed to refresh available models: unexpected status 401 Unauthorized: token_invalidated")))
        assertEquals("notice", rows.single().event.type)
        assertTrue(rows.single().event.body().startsWith("Startup · model_catalog · token_invalidated:"))
    }

    @Test fun unknownStructuredStderrKeepsTheErrorPath() {
        val rows = transcriptRows(listOf(stderr(1, "engine failed to start",
            """"diagnostic":{"component":"engine","severity":"ERROR","impact":"fatal","recoverable":false}""")))
        assertEquals(listOf("error" to "engine failed to start"), kinds(rows))
    }

    @Test fun multilineApplyPatchStderrFoldsIntoOneRow() {
        val rows = transcriptRows(listOf(
            stderr(1, "2026-09-29T23:54:05.014653Z ERROR codex_core::tools::router: error=apply_patch verification failed: Failed to find expected lines in /root/.orbit/worktrees/session/site/assets/README.md:"),
            stderr(2, "The HTML uses `data-asset-slot` attributes for future screenshots/GIFs"),
            stderr(3, "architecture. Do not add third-party tracking pixels without an explicit privacy review.")))
        val message = rows.single().event.body()
        assertEquals("error", rows.single().event.type)
        assertTrue(message.contains("site/assets/README.md:") && message.contains("The HTML uses") && message.contains("privacy review"))
        val summary = ToolFailureSummary.parse(message)!!
        assertEquals(ToolFailureSummary("apply_patch", "site/assets/README.md", "Expected lines not found"), summary)
    }

    @Test fun toolFailureStderrSettlesTheUnresolvedToolCard() {
        val rows = transcriptRows(listOf(
            event(1, "tool_use", """{"toolUseId":"t1","name":"Bash","input":{"command":"pwd"}}"""),
            event(2, "tool_result", """{"toolUseId":"t1","content":"/root/orbit"}"""),
            event(3, "tool_use", """{"toolUseId":"t2","name":"apply_patch","input":{"files":["/repo/README.md"]}}"""),
            stderr(4, "2026-09-29T23:54:05.014653Z ERROR codex_core::tools::router: error=apply_patch verification failed: Failed to find expected lines in /root/.orbit/worktrees/session/site/assets/README.md:"),
            // A sequence gap and a following tool_use must not leak the continuation as a second row.
            stderr(8, "The transcript's tool-call rendering: the folded/expandable card row, its semantic body (command /"),
            event(9, "tool_use", """{"toolUseId":"t3","name":"Bash","input":{"command":"git status"}}"""),
            event(10, "tool_result", """{"toolUseId":"t3","content":"clean"}""")))
        assertEquals(listOf("tool_use", "tool_use", "tool_use"), rows.map { it.event.type })
        val failed = rows[1].result!!
        assertEquals("true", failed.fields.string("isError"))
        assertTrue(failed.body().contains("semantic body"))
        assertEquals("event:3", anchorRow(rows, 4)!!.key)
    }

    @Test fun unnamedToolParserFailureSettlesTheLatestUnresolvedTool() {
        val rows = transcriptRows(listOf(event(1, "tool_use", """{"toolUseId":"t1","name":"mcp__orbit__task_create","input":{"title":"Ship it"}}"""),
            stderr(2, "error=failed to parse function arguments: unknown field `question`, expected `title` or `options` at line 1 column 174")))
        assertEquals("true", rows.single().result!!.fields.string("isError"))
        assertTrue(rows.single().result!!.body().contains("unknown field"))
    }

    @Test fun systemEventsWithoutStderrBenignLinesAndColourCodes() {
        assertTrue(transcriptRows(listOf(event(1, "system", """{"subtype":"thinking_tokens"}"""))).isEmpty())
        assertTrue(transcriptRows(listOf(stderr(1, "⚠ claude.ai connectors are disabled because ANTHROPIC_API_KEY or another auth source is set"))).isEmpty())
        assertTrue(transcriptRows(listOf("sdk", "generate_session_title").mapIndexed { i, source ->
            stderr(i + 1L, "[claude-code:unrecognized_model] {\"model\":\"deepseek-v4-pro\",\"query_source\":\"$source\"}\n") }).isEmpty())
        assertEquals(listOf("error" to "Error: Session ID abc is already in use."),
            kinds(transcriptRows(listOf(stderr(1, "\u001B[31mError: Session ID abc is already in use.\u001B[0m\n")))))
    }

    @Test fun repeatedEngineStderrFoldsIntoOneRow() {
        val rows = transcriptRows(listOf("2026-08-12T17:24:09.394Z", "2026-08-12T17:24:12.214Z", "2026-08-12T17:24:15.774Z")
            .mapIndexed { i, ts -> stderr(i + 1L, "$ts custom tool call output is missing") })
        assertEquals(listOf("error" to "2026-08-12T17:24:09.394Z custom tool call output is missing ×3"), kinds(rows))
    }

    @Test fun systemNoticeBecomesANoticeRowAndRepeatsAreNotFolded() {
        val notice = "Switched to Wikova · Pro — the 5-hour window on Zhang Min · Plus is spent"
        assertEquals(listOf("notice" to notice), kinds(transcriptRows(listOf(event(1, "system",
            """{"subtype":"init","sessionId":"s1","notice":${JsonPrimitive(notice)},"noticeKind":"pool-member-switched"}""")))))
        val twice = transcriptRows((1L..2L).map { event(it, "system", """{"notice":"Codex could not generate the image.","noticeKind":"codex-image-generation-failed"}""") })
        assertEquals(listOf("notice", "notice"), twice.map { it.event.type })
    }

    @Test fun apiErrorReplyBecomesAnErrorRowNotABubble() {
        val text = "API Error: 400 {\"type\":\"invalid_request_error\",\"message\":\"prompt is too long\"}"
        assertEquals(listOf("error" to text), kinds(transcriptRows(listOf(event(1, "assistant", """{"text":${JsonPrimitive(text)}}""")))))
    }

    @Test fun selfHealingFailuresBecomeAutoRetryRows() {
        val rows = transcriptRows(listOf(event(1, "user", """{"text":"keep going"}"""),
            event(2, "assistant", """{"text":"You've hit your session limit · resets 6:20pm (Europe/Berlin)"}""")))
        val card = rows.last().event
        assertEquals("auto_retry", card.type)
        assertEquals("quota", card.fields.string("variant"))
        assertEquals("false", card.fields.string("stale"))
        assertEquals("the message it would re-send is the line directly above", "true", card.fields.string("afterUserMsg"))
    }

    @Test fun codexCapacityAndUsageLimitErrorEventsBecomeAutoRetryRows() {
        val rows = transcriptRows(listOf(event(1, "user", """{"text":"go"}"""),
            event(2, "error", """{"message":"Selected model is at capacity. Please try a different model."}"""),
            event(3, "error", """{"message":"stream disconnected"}""")))
        assertEquals("auto_retry", rows[1].event.type)
        assertEquals("apiError", rows[1].event.fields.string("variant"))
        assertEquals("Selected model is at capacity. Please try a different model.", rows[1].event.body())
        assertEquals(listOf("error" to "stream disconnected"), kinds(rows.drop(2)))
        val quota = "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 6:58 AM."
        val card = transcriptRows(listOf(event(1, "error", """{"message":${JsonPrimitive(quota)}}"""))).single().event
        assertEquals("auto_retry" to quota, card.type to card.body())
        assertEquals("quota", card.fields.string("variant"))
    }

    /** A06-2: Codex's exhausted 429 budget is the same transient row as every other provider failure. */
    @Test fun codexRateLimitExhaustionIsATransientRow() {
        val message = "exceeded retry limit, last status: 429 Too Many Requests, request id: 95e00d6c-68cc-4d64-b4da-01a6252260c2"
        val card = transcriptRows(listOf(event(1, "user", """{"text":"go"}"""), event(2, "error", """{"message":${JsonPrimitive(message)}}"""))).last().event
        assertEquals("auto_retry", card.type)
        assertEquals("apiError", card.fields.string("variant"))
        assertEquals(message, card.body())
    }

    @Test fun theNextUserMessageAndASecondOutageSettleTheLiveRow() {
        val rows = transcriptRows(listOf(event(1, "assistant", """{"text":"API Error: 529 Overloaded"}"""),
            event(2, "user", """{"text":"again"}"""), event(3, "assistant", """{"text":"API Error: 503 Service Unavailable"}""")))
        val cards = rows.filter { it.event.type == "auto_retry" }.map { it.event.fields.string("stale") }
        assertEquals(listOf("true", "false"), cards)
    }

    @Test fun aSubagentsProviderErrorIsPartOfWhatItDid() {
        val rows = transcriptRows(listOf(event(1, "tool_use", """{"id":"agent","name":"Task"}"""),
            event(2, "assistant", """{"text":"API Error: 529 Overloaded","parentToolUseId":"agent"}""")))
        assertEquals(listOf("error" to "API Error: 529 Overloaded"), kinds(rows.single().children))
    }
}
