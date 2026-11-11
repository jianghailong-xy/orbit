package io.orbitd.android.reader

import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.core.realtime.RunEvent
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/**
 * The SubAgent block's row model (board docs/mocks/subagent/03.png), case for case with OrbitKit's `SubagentBlockTests`: the folded
 * second line with duration and cost once done and without them while running, Background in the type's place, the opened block's
 * Why line, what the block hands back, the re-read signature, and nesting without folding into a steps line.
 */
class SubagentBlockTest {
    private fun json(text: String) = Wire.json.parseToJsonElement(text)
    private val call = json("""{"type":"explore","description":"Find every caller of pollQuota","prompt":"Find every caller."}""")
    private val reasons = listOf("Tier S, set by the built-in explore default", "Optimize For: Cost", "Cheapest of 5 providers with quota on this runner")

    private fun run(type: String = "explore", background: Boolean = false, status: String = "DONE", level: String? = "S",
        model: String? = "deepseek-chat", modelLabel: String? = "DeepSeek Chat", reasons: List<String> = emptyList(), costUsd: Double = 0.21,
        resultSummary: String? = null, endedAt: String? = "2026-11-11T11:03:12.000Z") =
        SubagentRun("toolu_sa", type, background, status, level, model, modelLabel, reasons, costUsd, resultSummary,
            "2026-11-11T11:02:31.000Z", endedAt.takeIf { status != "RUNNING" })

    @Test fun theSecondLineCarriesTypeTierModelDurationAndCostOnceDone() {
        val block = SubagentBlock.describe(call, run(), callRunning = false)
        assertEquals("explore · S · DeepSeek Chat · 41s · $0.21", block.detailLine)
        assertEquals("explore", block.type)
        assertFalse(block.background)
        assertFalse(block.running)
    }

    @Test fun aRunningRunHasNoDurationOrCostYet() {
        // Even a call already answered: a run still going is running, and has nothing to time or price.
        val block = SubagentBlock.describe(call, run(status = "RUNNING", costUsd = 0.4), callRunning = false)
        assertEquals("explore · S · DeepSeek Chat", block.detailLine)
        assertTrue(block.running)
    }

    @Test fun aCostUnderACentReadsAsLessThanACent() {
        assertEquals("explore · S · DeepSeek Chat · 41s · <$0.01", SubagentBlock.describe(call, run(costUsd = 0.004), false).detailLine)
        assertEquals("explore · S · DeepSeek Chat · 41s · <$0.01", SubagentBlock.describe(call, run(costUsd = 0.0), false).detailLine)
    }

    @Test fun theCostHasTwoDecimals() {
        assertEquals("$0.03", SubagentBlock.cost(run(costUsd = 0.03)))
        assertEquals("$1.50", SubagentBlock.cost(run(costUsd = 1.5)))
        assertEquals("$0.13", SubagentBlock.cost(run(costUsd = 0.126)))
        assertNull(SubagentBlock.cost(run(status = "RUNNING")))
        assertNull(SubagentBlock.cost(null))
    }

    @Test fun aLongerRunReadsInMinutes() {
        val block = SubagentBlock.describe(call, run(endedAt = "2026-11-11T11:03:43.000Z"), false)
        assertEquals("explore · S · DeepSeek Chat · 1m 12s · $0.21", block.detailLine)
    }

    @Test fun theModelFallsBackToTheIdWhenTheTableNamesNone() {
        assertEquals("explore · S · deepseek-chat · 41s · $0.21", SubagentBlock.describe(call, run(modelLabel = null), false).detailLine)
    }

    @Test fun theCallSaysWhatItKnowsBeforeARunIsRead() {
        val block = SubagentBlock.describe(call, null, callRunning = true)
        assertEquals("explore", block.detailLine)
        assertTrue(block.running)
        assertNull(block.why)
    }

    @Test fun aTypeTheCallOmittedDefaultsToGeneral() {
        val block = SubagentBlock.describe(json("""{"description":"Write it"}"""), null, callRunning = false)
        assertEquals("general", block.type)
        assertEquals("general", block.detailLine)
        assertFalse(block.running)
    }

    @Test fun aBackgroundBlockPutsBackgroundInTheTypesPlaceAndAddsNoDurationWhileRunning() {
        val bgCall = json("""{"type":"general","description":"Write the backoff spec","background":true}""")
        val block = SubagentBlock.describe(bgCall, run(type = "general", background = true, status = "RUNNING", level = "M",
            model = "gpt-5.6-sol", modelLabel = "GPT-5.6 Sol", costUsd = 0.0), callRunning = false)
        assertTrue(block.background)
        assertTrue(block.running)
        assertEquals("Background · M · GPT-5.6 Sol", block.detailLine)
        assertEquals("the type is still known; the board draws Background in its place", "general", block.type)
    }

    @Test fun aBackgroundCallReadsAsBackgroundBeforeItsRunIsRead() {
        val block = SubagentBlock.describe(json("""{"type":"general","background":true}"""), null, callRunning = true)
        assertEquals("Background", block.detailLine)
    }

    @Test fun theRunsBackgroundFlagWinsOverTheCallsInput() {
        val block = SubagentBlock.describe(call, run(background = true), false)
        assertTrue(block.background)
        assertTrue(block.detailLine, block.detailLine.startsWith("Background · "))
    }

    @Test fun aFinishedBackgroundBlockAddsItsDurationAndCost() {
        val block = SubagentBlock.describe(json("""{"type":"general","background":true}"""), run(type = "general", background = true,
            level = "M", model = "gpt-5.6-sol", modelLabel = "GPT-5.6 Sol", costUsd = 0.03), callRunning = false)
        assertFalse(block.running)
        assertEquals("Background · M · GPT-5.6 Sol · 41s · $0.03", block.detailLine)
    }

    @Test fun theOpenedBlocksWhyJoinsTheRoutersReasons() {
        assertEquals("Tier S, set by the built-in explore default · Optimize For: Cost · Cheapest of 5 providers with quota on this runner",
            SubagentBlock.describe(call, run(reasons = reasons), false).why)
        assertEquals("an empty reason is left out", "Optimize For: Cost", SubagentBlock.describe(call, run(reasons = listOf("", "Optimize For: Cost")), false).why)
    }

    @Test fun aWhyWithNoReasonsIsAbsent() {
        assertNull(SubagentBlock.describe(call, run(), false).why)
        assertNull(SubagentBlock.describe(call, null, false).why)
    }

    @Test fun theRunIsReadFromTheSubagentsList() {
        val rows = (json("""[{"toolUseId":"toolu_sa_fg","type":"explore","background":false,"status":"DONE","level":"S","model":"deepseek-chat",
            "modelLabel":"DeepSeek Chat","effort":null,"reasons":["Optimize For: Cost"],"costUsd":0.03,"resultSummary":"Three callers, all in quota/.",
            "createdAt":"2026-11-11T11:02:31.000Z","endedAt":"2026-11-11T11:03:12.000Z"},
            {"toolUseId":"toolu_sa_bg","type":"general","background":true,"status":"RUNNING","level":"M","model":"gpt-5.6-sol","modelLabel":"GPT-5.6 Sol",
            "effort":null,"reasons":[],"costUsd":0,"resultSummary":null,"createdAt":"2026-11-11T11:02:33.000Z","endedAt":null},
            {"type":"no id"}]""") as JsonArray).map { it.jsonObject }
        val runs = SubagentRun.byCall(rows)
        assertEquals(setOf("toolu_sa_fg", "toolu_sa_bg"), runs.keys)
        assertEquals("explore · S · DeepSeek Chat · 41s · $0.03", SubagentBlock.describe(call, runs["toolu_sa_fg"], false).detailLine)
        assertEquals("Background · M · GPT-5.6 Sol", SubagentBlock.describe(call, runs["toolu_sa_bg"], false).detailLine)
        assertTrue(runs.getValue("toolu_sa_bg").isRunning)
    }

    // What the opened block ends with.

    @Test fun aForegroundResultCarriesTheSubAgentsText() {
        val result = """{"runId":"sa","status":"DONE","result":"Three callers, all in quota/.","changedFiles":[],"costUsd":0.03}"""
        assertEquals("Three callers, all in quota/.", SubagentResult.text(result, run()))
    }

    @Test fun aBackgroundReceiptIsHiddenUntilTheRunHasAResult() {
        val receipt = """{"runId":"sa_bg","status":"running"}"""
        assertNull(SubagentResult.text(receipt, run(background = true, status = "RUNNING")))
        assertEquals("Spec written.", SubagentResult.text(receipt, run(background = true, resultSummary = "Spec written.")))
    }

    @Test fun plainTextIsShownAsItCame() {
        assertEquals("not json", SubagentResult.text("not json", null))
        assertNull(SubagentResult.text("  ", null))
    }

    // Reading the runs, and the rows.

    private fun event(seq: Long, type: String, payload: String) = RunEvent(type, seq, json(payload))
    private val delegate = event(3, "tool_use", """{"id":"toolu_sa","name":"mcp__orbit__delegate","input":{"type":"explore","description":"Find"}}""")

    @Test fun theSignatureMovesWhenADelegateCallStartsOrEnds() {
        val started = SubagentRuns.signature(listOf(delegate))
        val answered = SubagentRuns.signature(listOf(delegate, event(7, "tool_result", """{"toolUseId":"toolu_sa","content":"{}"}""")))
        val ended = SubagentRuns.signature(listOf(delegate), listOf(json("""{"toolUseId":"toolu_sa","status":"completed"}""").jsonObject))
        assertEquals("toolu_sa", started)
        assertNotEquals(started, answered)
        assertNotEquals(started, ended)
        assertEquals("a session that never delegated reads nothing", "", SubagentRuns.signature(listOf(
            event(1, "tool_use", """{"id":"a","name":"Agent","input":{}}"""), event(2, "background_task", """{"toolUseId":"a","status":"completed"}"""))))
        // A child's own call is not the parent's delegate call.
        assertEquals("", SubagentRuns.signature(listOf(event(4, "tool_use",
            """{"id":"x","name":"mcp__orbit__delegate","input":{},"parentToolUseId":"toolu_other"}"""))))
    }

    @Test fun aDelegatesStepsNestUnderItsCallAndItIsNeverFoldedIntoAStepsLine() {
        val rows = Steps.group(transcriptRows(listOf(
            event(1, "tool_use", """{"id":"r","name":"Read","input":{"file_path":"a.kt"}}"""),
            event(2, "tool_result", """{"toolUseId":"r","content":"x"}"""),
            delegate,
            event(4, "tool_use", """{"id":"g","name":"Grep","input":{"pattern":"pollQuota","path":"src/"},"parentToolUseId":"toolu_sa"}"""),
            event(5, "tool_result", """{"toolUseId":"g","content":"src/poller.ts:14","parentToolUseId":"toolu_sa"}"""),
            event(6, "assistant", """{"text":"Three callers, all in quota/.","parentToolUseId":"toolu_sa"}"""),
            event(7, "tool_result", """{"toolUseId":"toolu_sa","content":"{}"}"""))))
        val block = rows.single { it.event.seq == 3L }
        assertTrue("the delegate call is its own row", block.steps.isEmpty())
        assertEquals(listOf("tool_use", "assistant"), block.children.map { it.event.type })
        assertEquals("Grep", block.children.first().event.fields.string("name"))
        assertFalse("its steps are its own, not the parent's", rows.any { row -> row.steps.any { it.event.seq == 4L } })
    }

    @Test fun aBackgroundDelegateWithNoStepsYetStillStandsAlone() {
        val bg = event(8, "tool_use", """{"id":"toolu_bg","name":"mcp__orbit__delegate","input":{"background":true}}""")
        assertFalse(Steps.groupable(transcriptRows(listOf(bg, event(9, "tool_result", """{"toolUseId":"toolu_bg","content":"{}"}"""))).single()))
    }
}
