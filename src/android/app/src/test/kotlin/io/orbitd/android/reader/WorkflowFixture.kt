package io.orbitd.android.reader

import io.orbitd.android.core.realtime.RunEvent
import kotlinx.serialization.json.*

/**
 * The board's workflow (docs/mocks/subagent-workflow part 4), the one OrbitKit's `WorkflowBlockTests` and the iOS probe shots use: four
 * reviews done, then eight verifies — while it runs two done, one failed, three running and two queued (no run yet); once finished, every
 * call ended and one of them failed.
 */
internal object WorkflowFixture {
    const val WF = "toolu_wf"
    const val RUN_ID = "4wRun0000000000000001"
    private val reviews = listOf("review:correctness", "review:timezones", "review:concurrency", "review:migrations")
    /** Each verify's run status while the workflow runs; "" is a call still queued. */
    private val verifies = listOf("DONE" to "Real", "DONE" to "Real", "FAILED" to null, "RUNNING" to null, "RUNNING" to null,
        "RUNNING" to null, "" to null, "" to null)

    val WAKE = """<orbit-workflow-finished>
  Workflow review-changes — Review the scheduler diff (run $RUN_ID) finished: DONE
    Calls done: 11, failed: 1. Cost: ${'$'}1.37.
    Result: Returned 3 confirmed findings.
  The control plane opened this turn for it.
</orbit-workflow-finished>"""

    /** What each verify handed back once it ended (the iOS probe's words). */
    private val verifyResults = listOf("nextRun() skips a day at DST end", "Lock released before the row write", "", "Cron parse drops seconds",
        "Not a bug: retries are bounded", "Not reproduced", "Not reproduced", "Not reproduced")
    private fun label(i: Int) = if (i < 4) reviews[i] else "verify"
    private fun phase(i: Int) = if (i < 4) "Review" else "Verify"
    /** The call's run status: [finished] ends every call, the third verify failed either way. */
    private fun status(i: Int, finished: Boolean): String = when {
        i < 4 -> "DONE"
        finished -> if (i == 6) "FAILED" else "DONE"
        else -> verifies[i - 4].first
    }
    private fun result(i: Int, finished: Boolean): String? = when {
        i < 4 -> "2 findings"
        status(i, finished) == "DONE" -> verifyResults[i - 4]
        else -> null
    }

    fun events(finished: Boolean = false, wake: Boolean = finished): List<RunEvent> = buildList {
        val ts = "2026-11-20T08:00:00.000Z"
        add(RunEvent("user", 1, buildJsonObject { put("text", "Review the scheduler change for bugs.") }, "turn-1", ts))
        add(RunEvent("assistant", 2, buildJsonObject { put("text", "I'll run a review workflow and check each finding.") }, "turn-1", ts))
        add(RunEvent("tool_use", 3, buildJsonObject {
            put("id", WF); put("name", WorkflowBlock.TOOL_NAME)
            putJsonObject("input") {
                put("description", "Review the scheduler diff")
                put("script", "export const meta = { name: 'review-changes', phases: [{ title: 'Review' }, { title: 'Verify' }] }")
            }
        }, "turn-1", ts))
        add(RunEvent("tool_result", 4, buildJsonObject {
            put("toolUseId", WF); put("content", """{"workflowRunId":"$RUN_ID","status":"running"}""")
        }, "turn-1", ts))
        var seq = 5L
        for (i in 0 until 12) {
            add(RunEvent("tool_use", seq++, buildJsonObject {
                put("id", "$WF#$i"); put("name", SubagentBlock.TOOL_NAME); put("parentToolUseId", WF)
                putJsonObject("input") { put("description", label(i)); put("prompt", "…"); put("workflow_phase", phase(i)) }
            }, "turn-1", ts))
            // The first verify's own step, which its SubAgent block draws.
            if (i == 4) add(RunEvent("assistant", seq++, buildJsonObject { put("text", "Reading the diff."); put("parentToolUseId", "$WF#4") }, "turn-1", ts))
            val status = status(i, finished)
            if (status == "DONE" || status == "FAILED") add(RunEvent("tool_result", seq++, buildJsonObject {
                put("toolUseId", "$WF#$i"); put("parentToolUseId", WF)
                put("content", result(i, finished)?.let { """{"status":"DONE","result":"$it"}""" } ?: """{"status":"FAILED"}""")
                if (status == "FAILED") put("isError", true)
            }, "turn-1", ts))
        }
        if (wake) {
            add(RunEvent("user", 100, buildJsonObject { put("text", WAKE); put("controlPlaneNote", WAKE) }, "turn-wake", ts))
            add(RunEvent("assistant", 101, buildJsonObject {
                put("text", "Three findings held up. The worst: nextRun() skips a day at DST end.")
            }, "turn-wake", ts))
        }
    }

    fun runs(finished: Boolean = false): Map<String, SubagentRun> = (0 until 12).mapNotNull { i ->
        val status = status(i, finished).ifEmpty { return@mapNotNull null }
        SubagentRun("$WF#$i", "general", false, status, "S", "deepseek-chat", "DeepSeek Chat", costUsd = 0.05,
            resultSummary = result(i, finished), why = "S: the workflow call asked for it", createdAt = "2026-11-20T08:00:00.000Z",
            endedAt = if (status == "RUNNING") null else "2026-11-20T08:01:00.000Z",
            workflowRunId = RUN_ID, callIndex = i, label = label(i), phase = phase(i))
    }.associateBy { it.toolUseId }

    fun workflow(status: String = "RUNNING", done: Int = 6, failed: Int = 1, cost: Double = 0.84, limit: Double? = null,
        error: String? = null, endedAt: String? = null) = WorkflowRun(RUN_ID, WF, "review-changes", "Review the scheduler diff",
        listOf("Review", "Verify"), status, done, failed, cost, limit, error, "2026-11-20T08:00:00.000Z", endedAt)

    val finishedWorkflow get() = workflow("DONE", 11, 1, 1.37, endedAt = "2026-11-20T08:06:40.000Z")

    /** The workflow call's row, with its calls nested under it, as the transcript builds it. */
    fun row(finished: Boolean = false): TranscriptRow = transcriptRows(events(finished, wake = false)).single { it.event.seq == 3L }
}
