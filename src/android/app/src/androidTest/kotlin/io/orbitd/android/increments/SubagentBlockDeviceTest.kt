package io.orbitd.android.increments

import androidx.compose.ui.test.*
import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import okhttp3.mockwebserver.MockResponse
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The SubAgent block (board docs/mocks/subagent/03.png) on a device, over the session the iOS evidence was shot on: the events page
 * and the GET /sessions/:id/subagents rows are the iOS seed's (`session-events.json`, `session-subagents.json`), byte for byte — one
 * finished foreground explore SubAgent and one background general SubAgent still running. Folded, then both opened.
 */
@RunWith(AndroidJUnit4::class)
class SubagentBlockDeviceTest : IncrementDeviceTest() {
    private val session = "34SubagentBlockShot001"
    override val ids get() = listOf(workspace, runner, session)

    private fun detail() = Json.parseToJsonElement("""{"id":"$session","title":"Quota poller retry","status":"RUNNING","runState":"RUNNING",
        "lifecycleState":"OPEN","provider":"claude","engine":"claude","model":"claude-opus-5","assignedRunnerId":"$runner",
        "agent":{"id":"$workspace","name":"SubAgent screens"},"agentId":"$workspace","createdAt":"2026-11-11T11:02:15.000Z",
        "lastTurnAt":"2026-11-11T11:02:45.000Z","capabilities":{"canSend":true,"canResume":false,"canComplete":true},"tags":[],
        "pendingApprovals":0}""").jsonObject.toString()
    override fun sessions(view: String, project: String?) = if (view == "open") "[${detail()}]" else "[]"

    override fun answer(req: Req): MockResponse? = when (req.path) {
        "sessions/$session" -> json(detail())
        "sessions/$session/events/page" -> json(EVENTS)
        "sessions/$session/subagents" -> json(SUBAGENTS)
        "sessions/$session/background" -> json("[]")
        else -> null
    }

    @Test fun theSubagentBlockFoldedAndOpened() = journey {
        signIn()
        open("orbit-session:$session")
        await("the session's page, fresh") { app.realtime.state.value.session?.fresh == true && exists(hasTestTag("transcript-list")) }
        await("the runs read") { says("event:3", "explore · S · DeepSeek Chat · 41s · $0.03") }
        verify("the running background block shows no duration or cost", says("event:8", "Background · M · GPT-5.6 Sol"))
        verify("the background block says what it is on", says("event:8", "Edit poller.spec.md"))
        verify("the subagents list was read", calls.any { it == "GET sessions/$session/subagents" })
        capture("android-folded")
        // The lower block first: opening the upper one pushes the lower one out of the list's composed rows.
        row("event:8").performClick(); settle()
        row("event:3").performClick(); settle()
        await("the finished block's Why line") { says("event:3",
            "Why · Tier S, set by the built-in explore default · Optimize For: Cost · Cheapest of 5 providers with quota on this runner") }
        verify("the hand-back closes it", says("event:3", "Three callers, all in quota/."))
        capture("android-open")
        scrollTranscriptTo(hasTestTag("event:8"))
        await("the background block's Why line") { says("event:8",
            "Why · Tier M, set by the caller: one service plus its spec · Optimize For: Cost · Cheapest of 5 providers with quota on this runner") }
        verify("opened, the italic live line gives way to the steps", !exists(hasTestTag("subagent-live-line"), unmerged = true))
        capture("android-open-background")
    }

    private fun row(event: String) = compose.onNode(hasTestTag("subagent-row") and hasAnyAncestor(hasTestTag(event)), useUnmergedTree = true)

    private companion object {
        const val EVENTS = """{"hasMore":false,"events":[{"seq":1,"type":"user","payload":{"text":"Add a retry with backoff to the quota poller."},"turnId":null,"ts":"2026-11-11T11:02:15.000Z","turnPublicId":null},{"seq":2,"type":"assistant","payload":{"text":"I'll split this: one SubAgent finds the callers, another writes the spec."},"turnId":null,"ts":"2026-11-11T11:02:19.000Z","turnPublicId":null},{"seq":3,"type":"tool_use","payload":{"id":"toolu_sa_fg","name":"mcp__orbit__delegate","input":{"type":"explore","prompt":"Find every caller of pollQuota in src/. Report file paths only.","description":"Find every caller of pollQuota"}},"turnId":null,"ts":"2026-11-11T11:02:21.000Z","turnPublicId":null},{"seq":4,"type":"tool_use","payload":{"id":"sa_fg_1","name":"Grep","input":{"path":"src/","pattern":"pollQuota"},"parentToolUseId":"toolu_sa_fg"},"turnId":null,"ts":"2026-11-11T11:02:24.000Z","turnPublicId":null},{"seq":5,"type":"tool_result","payload":{"content":"src/poller.ts:14\nsrc/quota.ts:88\nsrc/retry.ts:41","toolUseId":"sa_fg_1","parentToolUseId":"toolu_sa_fg"},"turnId":null,"ts":"2026-11-11T11:02:26.000Z","turnPublicId":null},{"seq":6,"type":"assistant","payload":{"text":"Three callers: poller.ts, quota.ts and retry.ts.","parentToolUseId":"toolu_sa_fg"},"turnId":null,"ts":"2026-11-11T11:02:28.000Z","turnPublicId":null},{"seq":7,"type":"tool_result","payload":{"content":"{\"runId\":\"sa_fg\",\"status\":\"DONE\",\"result\":\"Three callers, all in quota/.\",\"changedFiles\":[],\"model\":\"deepseek-chat\",\"costUsd\":0.03}","toolUseId":"toolu_sa_fg"},"turnId":null,"ts":"2026-11-11T11:02:31.000Z","turnPublicId":null},{"seq":8,"type":"tool_use","payload":{"id":"toolu_sa_bg","name":"mcp__orbit__delegate","input":{"type":"general","prompt":"Write the backoff spec for the quota poller in docs/poller.spec.md.","background":true,"description":"Write the backoff spec"}},"turnId":null,"ts":"2026-11-11T11:02:33.000Z","turnPublicId":null},{"seq":9,"type":"tool_result","payload":{"content":"{\"runId\":\"sa_bg\",\"status\":\"running\"}","toolUseId":"toolu_sa_bg"},"turnId":null,"ts":"2026-11-11T11:02:34.000Z","turnPublicId":null},{"seq":10,"type":"tool_use","payload":{"id":"sa_bg_1","name":"Edit","input":{"file_path":"docs/poller.spec.md","new_string":"## Retry\n\nExponential backoff, 5 attempts.","old_string":"## Retry"},"parentToolUseId":"toolu_sa_bg"},"turnId":null,"ts":"2026-11-11T11:02:41.000Z","turnPublicId":null},{"seq":11,"type":"assistant","payload":{"text":"Three callers, all in quota/. Changing the helper now."},"turnId":null,"ts":"2026-11-11T11:02:45.000Z","turnPublicId":null}]}"""
        const val SUBAGENTS = """[{"toolUseId":"toolu_sa_fg","type":"explore","background":false,"status":"DONE","level":"S","model":"deepseek-chat","modelLabel":"DeepSeek Chat","effort":null,"reasons":["Tier S, set by the built-in explore default","Optimize For: Cost","Cheapest of 5 providers with quota on this runner"],"costUsd":0.03,"resultSummary":"Three callers, all in quota/.","createdAt":"2026-11-11T11:02:31.000Z","endedAt":"2026-11-11T11:03:12.000Z"},{"toolUseId":"toolu_sa_bg","type":"general","background":true,"status":"RUNNING","level":"M","model":"gpt-5.6-sol","modelLabel":"GPT-5.6 Sol","effort":null,"reasons":["Tier M, set by the caller: one service plus its spec","Optimize For: Cost","Cheapest of 5 providers with quota on this runner"],"costUsd":0,"resultSummary":null,"createdAt":"2026-11-11T11:02:33.000Z","endedAt":null}]"""
    }
}
