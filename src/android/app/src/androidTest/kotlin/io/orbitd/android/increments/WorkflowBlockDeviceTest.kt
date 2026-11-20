package io.orbitd.android.increments

import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.serialization.json.*
import okhttp3.mockwebserver.MockResponse
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The Orbit workflow block (board docs/mocks/subagent-workflow part 4, following iOS) on a device, over the workflow the iOS probe shots
 * were taken of (OrbitKit `WorkflowBlockTests`' board state): four reviews done, then eight verifies. One session holds it running — two
 * verifies done, one failed, three running, two queued — and one holds it finished, with the `<orbit-workflow-finished>` wake turn and the
 * agent's answer under it. The events page, GET /sessions/:id/subagents and GET /sessions/:id/workflows are this fixture's.
 */
@RunWith(AndroidJUnit4::class)
class WorkflowBlockDeviceTest : IncrementDeviceTest() {
    private val running = "34WorkflowBlockRunning"
    private val finished = "34WorkflowBlockFinishd"
    override val ids get() = listOf(workspace, runner, running, finished)

    private fun detail(id: String, title: String) = Json.parseToJsonElement("""{"id":"$id","title":"$title","status":"RUNNING",
        "runState":"RUNNING","lifecycleState":"OPEN","provider":"claude","engine":"claude","model":"claude-opus-5","assignedRunnerId":"$runner",
        "agent":{"id":"$workspace","name":"Workflow screens"},"agentId":"$workspace","createdAt":"2026-11-20T08:00:00.000Z",
        "lastTurnAt":"2026-11-20T08:06:40.000Z","capabilities":{"canSend":true,"canResume":false,"canComplete":true},"tags":[],
        "pendingApprovals":0}""").jsonObject.toString()
    override fun sessions(view: String, project: String?) =
        if (view == "open") "[${detail(running, "Scheduler review")},${detail(finished, "Scheduler review, finished")}]" else "[]"

    override fun answer(req: Req): MockResponse? = when (req.path) {
        "sessions/$running" -> json(detail(running, "Scheduler review"))
        "sessions/$finished" -> json(detail(finished, "Scheduler review, finished"))
        "sessions/$running/events/page" -> json(events(done = false))
        "sessions/$finished/events/page" -> json(events(done = true))
        "sessions/$running/subagents" -> json(runs(done = false))
        "sessions/$finished/subagents" -> json(runs(done = true))
        "sessions/$running/workflows" -> json(workflow(done = false))
        "sessions/$finished/workflows" -> json(workflow(done = true))
        "sessions/$running/background", "sessions/$finished/background" -> json("[]")
        else -> null
    }

    private fun tap(matcher: SemanticsMatcher) {
        compose.onNode(matcher, useUnmergedTree = true).performSemanticsAction(SemanticsActions.OnClick)
        settle()
    }

    @Test fun theRunningWorkflowFoldedItsCallsAndACallsSubagent() = journey {
        signIn()
        open("orbit-session:$running")
        await("the session's page, fresh") { app.realtime.state.value.session?.fresh == true && exists(hasTestTag("transcript-list")) }
        await("the workflow read") { says("workflow-progress", "Verify · 7 of 12 · $0.84") }
        verify("the italic line says what runs and waits", says("workflow-live", "3 running, 2 queued"))
        verify("it spins", exists(hasTestTag("workflow-running"), unmerged = true))
        verify("the workflows were read", calls.any { it == "GET sessions/$running/workflows" })
        capture("android-folded-running")
        tap(hasTestTag("workflow-block"))
        awaitTag("workflow-calls-list")
        verify("the phases with their counts", says("workflow-calls-list", "VERIFY · 3 DONE · 3 RUNNING · 2 QUEUED"))
        verify("the ended phase is folded", says("workflow-calls-list", "2 more"))
        capture("android-calls-page")
        tap(hasTestTag("workflow-call:toolu_wf#4"))
        awaitTag("workflow-call-detail")
        await("the call's SubAgent block") { says("workflow-call-detail", "general · S · DeepSeek Chat · 1m") }
        capture("android-call-detail")
        tap(hasTestTag("workflow-call-back"))
        awaitTag("workflow-calls-list")
        tap(hasTestTag("workflow-calls-done"))
        await("the page closed") { !exists(hasTestTag("workflow-calls")) }
    }

    @Test fun theFinishedWorkflowAndItsStrip() = journey {
        signIn()
        open("orbit-session:$finished")
        await("the session's page, fresh") { app.realtime.state.value.session?.fresh == true && exists(hasTestTag("transcript-list")) }
        await("the workflow read") { says("workflow-progress", "12 of 12 · $1.37") }
        await("the strip") { says("workflow-finished-strip", "12 calls · 1 failed · 6m 40s · $1.37") }
        verify("the strip says how it ended", says("workflow-finished-strip", "Workflow finished"))
        verify("no raw block", !exists(hasText("<orbit-workflow-finished>", substring = true), unmerged = true))
        capture("android-folded-finished-strip")
        tap(hasTestTag("workflow-block"))
        awaitTag("workflow-calls-list")
        verify("every call ended", says("workflow-calls-list", "VERIFY · 8 DONE"))
        capture("android-calls-page-finished")
    }

    // ---- The board's workflow, as OrbitKit's WorkflowBlockTests and the Android WorkflowFixture build it. ----

    private val wf = "toolu_wf"
    private val runId = "4wRun0000000000000001"
    private val ts = "2026-11-20T08:00:00.000Z"
    private val reviews = listOf("review:correctness", "review:timezones", "review:concurrency", "review:migrations")
    private val verifies = listOf("DONE", "DONE", "FAILED", "RUNNING", "RUNNING", "RUNNING", "", "")
    /** What each verify handed back once it ended (the iOS probe's words). */
    private val verifyResults = listOf("nextRun() skips a day at DST end", "Lock released before the row write", "", "Cron parse drops seconds",
        "Not a bug: retries are bounded", "Not reproduced", "Not reproduced", "Not reproduced")
    private fun label(i: Int) = if (i < 4) reviews[i] else "verify"
    private fun phase(i: Int) = if (i < 4) "Review" else "Verify"
    private fun status(i: Int, done: Boolean) = when { i < 4 -> "DONE"; done -> if (i == 6) "FAILED" else "DONE"; else -> verifies[i - 4] }
    private fun result(i: Int, done: Boolean) = when { i < 4 -> "2 findings"; status(i, done) == "DONE" -> verifyResults[i - 4]; else -> null }

    private val wake = """<orbit-workflow-finished>
  Workflow review-changes — Review the scheduler diff (run $runId) finished: DONE
    Calls done: 11, failed: 1. Cost: ${'$'}1.37.
    Result: Returned 3 confirmed findings.
  The control plane opened this turn for it.
</orbit-workflow-finished>"""

    private fun events(done: Boolean): String {
        val rows = mutableListOf<JsonObject>()
        var seq = 1
        fun add(type: String, payload: JsonObject) { rows += buildJsonObject { put("seq", seq++); put("type", type); put("payload", payload); put("ts", ts) } }
        add("user", buildJsonObject { put("text", "Review the scheduler change for bugs.") })
        add("assistant", buildJsonObject { put("text", "I'll run a review workflow and check each finding.") })
        add("tool_use", buildJsonObject { put("id", wf); put("name", "mcp__orbit__workflow"); putJsonObject("input") {
            put("description", "Review the scheduler diff")
            put("script", "export const meta = { name: 'review-changes', phases: [{ title: 'Review' }, { title: 'Verify' }] }") } })
        add("tool_result", buildJsonObject { put("toolUseId", wf); put("content", """{"workflowRunId":"$runId","status":"running"}""") })
        for (i in 0 until 12) {
            add("tool_use", buildJsonObject { put("id", "$wf#$i"); put("name", "mcp__orbit__delegate"); put("parentToolUseId", wf)
                putJsonObject("input") { put("description", label(i)); put("prompt", "…"); put("workflow_phase", phase(i)) } })
            if (i == 4) add("assistant", buildJsonObject { put("text", "Reading the diff."); put("parentToolUseId", "$wf#4") })
            val status = status(i, done)
            if (status == "DONE" || status == "FAILED") add("tool_result", buildJsonObject {
                put("toolUseId", "$wf#$i"); put("parentToolUseId", wf)
                put("content", result(i, done)?.let { """{"status":"DONE","result":"$it"}""" } ?: """{"status":"FAILED"}""")
                if (status == "FAILED") put("isError", true) })
        }
        if (done) {
            add("user", buildJsonObject { put("text", wake); put("controlPlaneNote", wake) })
            add("assistant", buildJsonObject { put("text", "Three findings held up. The worst: nextRun() skips a day at DST end.") })
        }
        return buildJsonObject { put("hasMore", false); put("events", JsonArray(rows)) }.toString()
    }

    private fun runs(done: Boolean) = JsonArray((0 until 12).mapNotNull { i ->
        val status = status(i, done).ifEmpty { return@mapNotNull null }
        buildJsonObject {
            put("toolUseId", "$wf#$i"); put("type", "general"); put("background", false); put("status", status); put("level", "S")
            put("model", "deepseek-chat"); put("modelLabel", "DeepSeek Chat"); put("costUsd", 0.05); put("resultSummary", result(i, done))
            put("why", "S: the workflow call asked for it")
            put("createdAt", ts); put("endedAt", if (status == "RUNNING") null else "2026-11-20T08:01:00.000Z")
            put("workflowRunId", runId); put("callIndex", i); put("label", label(i)); put("phase", phase(i))
        }
    }).toString()

    private fun workflow(done: Boolean) = JsonArray(listOf(buildJsonObject {
        put("id", runId); put("toolUseId", wf); put("name", "review-changes"); put("description", "Review the scheduler diff")
        put("phases", JsonArray(listOf(JsonPrimitive("Review"), JsonPrimitive("Verify")))); put("status", if (done) "DONE" else "RUNNING")
        put("callsDone", if (done) 11 else 6); put("callsFailed", 1); put("costUsd", if (done) 1.37 else 0.84); put("maxCostUsd", JsonNull)
        put("error", JsonNull); put("createdAt", ts); put("endedAt", if (done) "2026-11-20T08:06:40.000Z" else null)
    })).toString()
}
