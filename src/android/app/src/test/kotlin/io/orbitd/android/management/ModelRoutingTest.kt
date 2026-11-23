package io.orbitd.android.management

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.time.Instant

/** Model routing's rules with no view in them (web `lib/routingReport.ts`, `lib/subagentTiers.ts`): the report's rows joined to the
 *  tier list in their sections, and every word and figure a row says — each word a literal of the web page it was ported from. */
class ModelRoutingTest {
    private val providers = Subagents.decode(Json.parseToJsonElement(SubagentFixtures.TIERS))
    private val groups = ModelRouting.decode(Json.parseToJsonElement(SubagentFixtures.REPORT))
    private val sections = ModelRouting.sections(providers, groups)
    private fun row(list: List<RoutingModelRow>, model: String) = list.single { it.modelLabel == model }

    @Test fun theReportDecodesAndANonReportReadsAsNone() {
        assertEquals(7, groups.size)
        assertEquals(SubagentReportGroup("L", "claude", "Claude", "claude-opus-5-5", "claude-opus-5-5", 5, 2, 4, 3, 0.0, 1, 0), groups[2])
        assertEquals(emptyList<SubagentReportGroup>(), ModelRouting.decode(JsonArray(emptyList())))
        assertEquals(emptyList<SubagentReportGroup>(), ModelRouting.decode(Json.parseToJsonElement("""{"subagents":[{"runs":1}]}""")))
    }

    @Test fun rowsGoInTheirSectionsMostRunsFirstThenTheTierListsOrder() {
        // Every model with a tier, and every model routed at one: opus 5, deepseek 4, qwen 2, the removed key's 1, then the tiered
        // models with no routed runs in the tier list's order.
        assertEquals(listOf("claude-opus-5-5", "deepseek-chat", "qwen-coder", "old-model", "claude-sonnet-5-5", "gpt-5.6-sol"),
            sections.tiered.map { it.modelLabel })
        assertEquals(listOf("claude-sonnet-5-5"), sections.named.map { it.modelLabel })
        assertEquals(listOf("gpt-5.6-sol"), sections.notRouted.map { it.modelLabel })
        assertEquals(emptyList<RoutingModelRow>(), sections.idle)
        // Joined on provider slug and model id: the tier list's model and provider, its label over the report's.
        val deepseek = row(sections.tiered, "deepseek-chat")
        assertEquals(listOf("S", "M"), deepseek.model!!.levels)
        assertEquals("DeepSeek", deepseek.providerLabel)
        assertEquals(RunFigures(4, 4, 3, 0.42, 0), deepseek.figures.copy(costUsd = Math.round(deepseek.figures.costUsd * 100) / 100.0))
        assertEquals(listOf("S" to false, "L" to true), deepseek.tiers.map { it.tier to it.outside })
        assertEquals(1, deepseek.outsideRuns)
        // A model the list no longer has: no tier, quality or price, and never outside its tier.
        val gone = row(sections.tiered, "old-model")
        assertNull(gone.model); assertNull(gone.provider)
        assertEquals("Old key", gone.providerLabel)
        assertEquals(0, gone.outsideRuns)
        // No tier at all: every routed run is outside.
        assertEquals(2, row(sections.tiered, "qwen-coder").outsideRuns)
    }

    @Test fun aModelWithNoTierAndNoRunsIsFoldedAway() {
        val idle = ModelRouting.sections(providers, emptyList())
        assertEquals(listOf("qwen-coder"), idle.idle.map { it.modelLabel })
        assertEquals(listOf("deepseek-chat", "claude-sonnet-5-5", "claude-opus-5-5", "gpt-5.6-sol"), idle.tiered.map { it.modelLabel })
        assertEquals("▸ No tier, no runs · 1 model", ModelRouting.idleFold(1, open = false))
        assertEquals("▾ No tier, no runs · 3 models", ModelRouting.idleFold(3, open = true))
        // Called by name only: not idle, and not tiered either.
        val named = ModelRouting.sections(providers, groups.filter { it.model == "qwen-coder" }.map { it.copy(tier = "named") })
        assertEquals(emptyList<RoutingModelRow>(), named.idle)
        assertEquals(listOf("qwen-coder"), named.named.map { it.modelLabel })
        assertFalse(named.tiered.any { it.modelLabel == "qwen-coder" })
    }

    @Test fun eachRowSaysRanAtRunsDoneAndCost() {
        val deepseek = row(sections.tiered, "deepseek-chat")
        assertEquals("S 3 · L 1 ⚑", ModelRouting.ranAtText(deepseek, RanAt.TIERS))
        assertEquals("Ran at S 3, L 1 (outside its tier)", ModelRouting.ranAtDescription(deepseek, RanAt.TIERS))
        assertEquals("Ran at S 3, L 1 (outside its tier), Runs 4, Done 75%, Cost $0.42", ModelRouting.figuresDescription(deepseek, RanAt.TIERS))
        assertEquals("75%", ModelRouting.doneText(deepseek))
        assertEquals("$0.42", ModelRouting.costCell(deepseek))
        val idle = row(sections.tiered, "claude-sonnet-5-5")
        assertEquals("No runs", ModelRouting.ranAtText(idle, RanAt.TIERS))
        assertEquals("—", ModelRouting.doneText(idle))
        assertEquals("—", ModelRouting.costCell(idle))
        assertEquals("Named", ModelRouting.ranAtText(row(sections.named, "claude-sonnet-5-5"), RanAt.NAMED))
        val notRouted = row(sections.notRouted, "gpt-5.6-sol")
        assertEquals("Not routed", ModelRouting.ranAtText(notRouted, RanAt.NOT_ROUTED))
        assertEquals("—", ModelRouting.doneText(notRouted))
        assertEquals("$0.00", ModelRouting.costCell(notRouted))
    }

    @Test fun theFlagSaysWhichRunsWereOutsideTheModelsTiers() {
        assertEquals("1 run at L, outside S · M", ModelRouting.flag(row(sections.tiered, "deepseek-chat")))
        assertEquals("No tier set, but routed 2 times", ModelRouting.flag(row(sections.tiered, "qwen-coder")))
        assertNull(ModelRouting.flag(row(sections.tiered, "claude-opus-5-5")))
        assertNull(ModelRouting.flag(row(sections.tiered, "old-model")))
        val once = ModelRouting.sections(providers, groups.filter { it.model == "qwen-coder" }.map { it.copy(runs = 1) })
        assertEquals("No tier set, but routed 1 time", ModelRouting.flag(once.tiered.single { it.modelLabel == "qwen-coder" }))
        // Outside at two tiers of a model set to every other: `tierText` names what it is set to.
        val two = ModelRouting.sections(providers, listOf("L", "XL").map { groups[0].copy(tier = it, runs = 2) })
        assertEquals("4 runs at L · XL, outside S · M", ModelRouting.flag(two.tiered.single { it.modelLabel == "deepseek-chat" }))
    }

    @Test fun theTotalsLineSaysWhatTheWebsSays() {
        assertEquals("15 runs, 2 of them workflow calls · 77% done · $0.48 · 1 moved on · 8% without a size" to "2 models ran outside their tiers",
            ModelRouting.totals(groups, sections, ReportPeriod.MONTH))
        val one = groups.take(1)
        assertEquals("3 runs · 67% done · $0.12 · 0 moved on · 33% without a size" to null,
            ModelRouting.totals(one, ModelRouting.sections(providers, one), ReportPeriod.MONTH))
        assertEquals("No SubAgents ran yet." to null, ModelRouting.totals(emptyList(), sections, ReportPeriod.ALL))
    }

    @Test fun figuresAndThePeriodsWords() {
        assertEquals("1 run", ModelRouting.plural(1, "run"))
        assertEquals("2 runs", ModelRouting.plural(2, "run"))
        assertEquals("0 models", ModelRouting.plural(0, "model"))
        assertEquals("$0.00", ModelRouting.costText(0.0))
        assertEquals("$1.25", ModelRouting.costText(1.249))
        assertEquals(75, ModelRouting.percent(3, 4))
        assertEquals(67, ModelRouting.percent(2, 3))
        assertEquals(50, ModelRouting.percent(1, 2))
        // JavaScript's Math.round: half rounds up.
        assertEquals(13, ModelRouting.percent(1, 8))
        assertNull(ModelRouting.percent(0, 0))
        assertEquals(listOf("Last 7 days", "Last 30 days", "All time"), ReportPeriod.entries.map { it.label })
        assertEquals(ReportPeriod.MONTH, ReportPeriod.DEFAULT)
        val now = Instant.parse("2026-11-22T12:00:00Z").toEpochMilli()
        assertEquals("2026-11-15T12:00:00Z", ModelRouting.since(ReportPeriod.WEEK, now))
        assertEquals("2026-10-23T12:00:00Z", ModelRouting.since(ReportPeriod.MONTH, now))
        assertNull(ModelRouting.since(ReportPeriod.ALL, now))
        assertEquals("No SubAgents ran in the last 30 days.", ModelRouting.noneRan(ReportPeriod.MONTH))
        assertEquals("No SubAgents ran in the last 7 days.", ModelRouting.noneRan(ReportPeriod.WEEK))
        assertEquals("No SubAgents ran yet.", ModelRouting.noneRan(ReportPeriod.ALL))
        assertEquals("Couldn’t load the report: boom", ModelRouting.loadFailed("boom"))
    }

    private val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }.first { File(it, "src/web/src").isDirectory }
    /** A TypeScript file with its string concatenations joined and its escaped quotes read, so a sentence split over lines is one. */
    private fun web(path: String) = File(root, path).also { assertTrue("$path is gone", it.isFile) }.readText()
        .replace(Regex("""['"]\s*\+\s*['"]"""), "").replace("\\'", "'")

    @Test fun everyWordIsTheWebPagesOwn() {
        val page = web("src/web/src/pages/settings/ModelRoutingPage.tsx")
        val report = web("src/web/src/lib/routingReport.ts")
        val tiers = web("src/web/src/lib/subagentTiers.ts")
        fun says(source: String, file: String, literal: String) = assertTrue("$file no longer says $literal", source.contains(literal))
        says(page, "ModelRoutingPage.tsx", "title=\"${ModelRouting.TITLE}\" description=\"${ModelRouting.DESCRIPTION}\"")
        says(page, "ModelRoutingPage.tsx", "<SettingsSection title=\"${ModelRouting.ROUTING}\">")
        says(page, "ModelRoutingPage.tsx", "title=\"${ModelRouting.MODELS}\"")
        says(page, "ModelRoutingPage.tsx", "aria-label=\"${ModelRouting.PERIOD}\"")
        says(page, "ModelRoutingPage.tsx", "<SectionRow title=\"${ModelRouting.ROUTED_BY_TIER}\" />")
        says(page, "ModelRoutingPage.tsx", "<SectionRow title=\"${ModelRouting.CALLED_BY_NAME}\" note=\"${ModelRouting.CALLED_BY_NAME_NOTE}\" />")
        says(page, "ModelRoutingPage.tsx", "<SectionRow title=\"${ModelRouting.NOT_ROUTED}\" />")
        says(page, "ModelRoutingPage.tsx", "ranAt=\"${ModelRouting.NAMED}\"")
        says(page, "ModelRoutingPage.tsx", ">${ModelRouting.NO_RUNS}</span>")
        listOf(ModelRouting.RAN_AT, ModelRouting.RUNS, ModelRouting.DONE, ModelRouting.COST).forEach { says(page, "ModelRoutingPage.tsx", ">$it</th>") }
        says(page, "ModelRoutingPage.tsx", "Couldn’t load the report: {")
        assertTrue("ModelRoutingPage.tsx no longer says Retry", Regex(""">\s*${ModelRouting.RETRY}\s*</Button>""").containsMatchIn(page))
        says(page, "ModelRoutingPage.tsx", "No SubAgents ran {periodPhrase(period)}.")
        says(page, "ModelRoutingPage.tsx", "{showIdle ? '▾' : '▸'} No tier, no runs · {plural(sections.idle.length, 'model')}")
        says(page, "ModelRoutingPage.tsx", "`No tier set, but routed \${plural(row.outsideRuns, 'time')}`")
        says(page, "ModelRoutingPage.tsx", "`\${plural(row.outsideRuns, 'run')} at \${outsideTiers.join(' · ')}, outside \${tierText(row.model?.levels ?? [])}`")
        says(page, "ModelRoutingPage.tsx", "{tier.outside ? ' (outside its tier)' : ''}")
        // The two footnotes under the list, one after the other.
        assertTrue("ModelRoutingPage.tsx's footnotes moved",
            Regex("""<p className="routing-report-foot">\{SUBAGENTS_FOOT}</p>\s*<p className="routing-report-foot">\{QUALITY_FOOT}</p>""").containsMatchIn(page))
        says(report, "routingReport.ts", "SUBAGENTS_FOOT =\n  '${ModelRouting.SUBAGENTS_FOOT}'")
        says(tiers, "subagentTiers.ts", "QUALITY_FOOT = '${Subagents.QUALITY_FOOTER}'")
        ReportPeriod.entries.forEach { says(report, "routingReport.ts", "label: '${it.label}'") }
        says(report, "routingReport.ts", "`in the last \${PERIOD_DAYS[period]} days`")
        says(report, "routingReport.ts", "'yet'")
        says(report, "routingReport.ts", "DEFAULT_REPORT_PERIOD: ReportPeriod = '30d'")
        says(report, "routingReport.ts", "'No model'")
        // The totals line's words.
        listOf("of them workflow call", "moved on", "% without a size", "ran outside", "its tier", "their tiers").forEach {
            says(page, "ModelRoutingPage.tsx", it)
        }
    }
}
