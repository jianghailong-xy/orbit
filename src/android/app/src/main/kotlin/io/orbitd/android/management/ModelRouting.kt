package io.orbitd.android.management

import io.orbitd.android.core.net.ApiError
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import java.time.Instant
import java.util.Locale

/** One row of `GET tasks/model-routing/report/subagents`' subagents (shared SubagentReportGroup): the SubAgent runs routed at one
 *  tier onto one provider and model. [tier] is S, M, L or XL, `named` or `not-routed`. */
internal data class SubagentReportGroup(val tier: String, val provider: String?, val providerLabel: String?, val model: String?,
                                        val modelLabel: String?, val runs: Int, val workflowCalls: Int, val ended: Int, val done: Int,
                                        val costUsd: Double, val movedOn: Int, val noSize: Int)

/** How one model's runs went, summed over the report rows that picked it (web RunFigures). */
internal data class RunFigures(val runs: Int, val ended: Int, val done: Int, val costUsd: Double, val movedOn: Int)

/** One tier a model was routed at: its runs there, and whether that tier is one the model is set to now (web TierRuns). */
internal data class TierRuns(val tier: String, val figures: RunFigures, val outside: Boolean) {
    val runs get() = figures.runs
}

/** One model row of the Models list (web RoutingModelRow): the model as the tier list names it (null when the list no longer has
 *  it), with the runs routing gave it in the period. */
internal data class RoutingModelRow(val key: String, val provider: SubagentProvider?, val model: SubagentTierModel?, val modelLabel: String,
                                    val providerLabel: String?, val figures: RunFigures, val tiers: List<TierRuns>, val outsideRuns: Int) {
    val runs get() = figures.runs
}

/** The Models list's rows, in its sections (web RoutingSections). */
internal data class RoutingSections(val tiered: List<RoutingModelRow>, val named: List<RoutingModelRow>,
                                    val notRouted: List<RoutingModelRow>, val idle: List<RoutingModelRow>)

/** The report's period (web REPORT_PERIODS): Last 30 days unless another is picked. */
internal enum class ReportPeriod(val label: String, val days: Int?) {
    WEEK("Last 7 days", 7), MONTH("Last 30 days", 30), ALL("All time", null);
    companion object { val DEFAULT = MONTH }
}

/** What a model row's Ran at says: the tiers its runs were routed at, or a word for runs routing picked no tier for. */
internal enum class RanAt { TIERS, NAMED, NOT_ROUTED }

/**
 * Settings → Providers → Model routing (web `ModelRoutingPage.tsx`, its words and figures from `lib/routingReport.ts` and
 * `lib/subagentTiers.ts`): the account's routing switches, then every model with its tier beside how its SubAgent runs went.
 */
internal object ModelRouting {
    const val TITLE = "Model routing"
    const val DESCRIPTION = "Which tier each model takes SubAgent work at, and how that work went."
    const val ROUTING = "Routing"
    const val MODELS = "Models"
    const val PERIOD = "Period"
    const val ROUTED_BY_TIER = "Routed by tier"
    const val CALLED_BY_NAME = "Called by name"
    const val CALLED_BY_NAME_NOTE = "The SubAgent named its model, so no tier was picked."
    const val NOT_ROUTED = "Not routed"
    const val NAMED = "Named"
    const val NO_RUNS = "No runs"
    const val RAN_AT = "Ran at"
    const val RUNS = "Runs"
    const val DONE = "Done"
    const val COST = "Cost"
    const val RETRY = "Retry"
    const val SUBAGENTS_FOOT =
        "Each run counts under the model Orbit picked for it, workflow calls included; Ran at splits its runs by the tier they " +
        "were routed at. Done: ended runs that finished. Moved on: the pick hit a usage limit and the run went on with the " +
        "next model. No size: the call gave no size, so its type's default tier applied. A subscription that reports no " +
        "price adds $0. Preset tiers and prices follow the catalogue. A model with no tier still runs SubAgents, after every " +
        "model whose tier fits."
    /** The tiers in order; a tier the model is not set to now is marked with this as well as the flag colour. */
    const val OUTSIDE_MARK = "⚑"
    private const val DAY_MS = 86_400_000L

    fun loadFailed(message: String) = "Couldn’t load the report: $message"

    /** An error's words as the page says them: the server's own sentence where it sent one. */
    fun errorMessage(e: Exception): String = when (e) {
        is ApiError -> e.messages.joinToString("; ").ifBlank { e.message.orEmpty() }
        else -> e.message ?: "Could not reach the server"
    }

    /** Where the period starts, as the report's `since`: none for All time (web reportSince). */
    fun since(period: ReportPeriod, nowMs: Long): String? = period.days?.let { Instant.ofEpochMilli(nowMs - it * DAY_MS).toString() }

    /** The period in a sentence's words: `in the last 30 days`, or `yet` for All time (web periodPhrase). */
    fun periodPhrase(period: ReportPeriod) = period.days?.let { "in the last $it days" } ?: "yet"

    fun noneRan(period: ReportPeriod) = "No SubAgents ran ${periodPhrase(period)}."

    fun plural(count: Int, word: String) = "$count $word${if (count == 1) "" else "s"}"

    fun costText(usd: Double): String = String.format(Locale.US, "$%.2f", usd)

    /** [part] of [whole] as a whole percentage; null when there is no whole (web percent, which rounds half up). */
    fun percent(part: Int, whole: Int): Int? = if (whole > 0) Math.round(part.toDouble() / whole * 100).toInt() else null

    /** The Done cell: `75%`, or `—` with no ended runs. */
    fun doneText(row: RoutingModelRow) = percent(row.figures.done, row.figures.ended)?.let { "$it%" } ?: "—"

    /** The Cost cell: `$0.42`, or `—` with no runs. */
    fun costCell(row: RoutingModelRow) = if (row.runs == 0) "—" else costText(row.figures.costUsd)

    /** The Ran at cell, as segments: each tier routed at with its runs (`S 3`) and whether it is outside the model's tiers; or one
     *  word — Named, Not routed, No runs. */
    fun ranAtSegments(row: RoutingModelRow, ranAt: RanAt): List<Pair<String, Boolean>> = when {
        ranAt == RanAt.NAMED -> listOf(NAMED to false)
        ranAt == RanAt.NOT_ROUTED -> listOf(NOT_ROUTED to false)
        row.runs == 0 -> listOf(NO_RUNS to false)
        else -> row.tiers.map { "${it.tier} ${it.runs}" + (if (it.outside) " $OUTSIDE_MARK" else "") to it.outside }
    }

    /** The Ran at cell in one line: `S 3 · L 1 ⚑`. */
    fun ranAtText(row: RoutingModelRow, ranAt: RanAt) = ranAtSegments(row, ranAt).joinToString(" · ") { it.first }

    /** What a screen reader says for Ran at: the web bar's label, `Ran at S 3, L 1 (outside its tier)`. */
    fun ranAtDescription(row: RoutingModelRow, ranAt: RanAt) =
        if (ranAt != RanAt.TIERS || row.runs == 0) "$RAN_AT ${ranAtText(row, ranAt)}"
        else "$RAN_AT " + row.tiers.joinToString(", ") { "${it.tier} ${it.runs}${if (it.outside) " (outside its tier)" else ""}" }

    /** What a screen reader says for a row's figures: Ran at as [ranAtDescription] says it, then Runs, Done and Cost. */
    fun figuresDescription(row: RoutingModelRow, ranAt: RanAt) =
        "${ranAtDescription(row, ranAt)}, $RUNS ${row.runs}, $DONE ${doneText(row)}, $COST ${costCell(row)}"

    /** The line under a routed model's name when some of its runs were outside its tiers; null when none were. */
    fun flag(row: RoutingModelRow): String? {
        if (row.outsideRuns <= 0) return null
        val model = row.model
        if (model != null && model.levels.isEmpty()) return "No tier set, but routed ${plural(row.outsideRuns, "time")}"
        val outside = row.tiers.filter { it.outside }.joinToString(" · ") { it.tier }
        return "${plural(row.outsideRuns, "run")} at $outside, outside ${Subagents.tierText(model?.levels.orEmpty())}"
    }

    /** The folded row of models with no tier and no runs. */
    fun idleFold(count: Int, open: Boolean) = "${if (open) "▾" else "▸"} No tier, no runs · ${plural(count, "model")}"

    /** The line over the list: the period's runs, share done, cost, how many moved on and went without a size, and how many models
     *  ran outside their tiers (the second, flagged, part); null second part when none did. */
    fun totals(groups: List<SubagentReportGroup>, sections: RoutingSections, period: ReportPeriod): Pair<String, String?> {
        if (groups.isEmpty()) return noneRan(period) to null
        val runs = groups.sumOf { it.runs }
        val calls = groups.sumOf { it.workflowCalls }
        val done = percent(groups.sumOf { it.done }, groups.sumOf { it.ended })
        val noSize = percent(groups.sumOf { it.noSize }, groups.filter { routed(it.tier) }.sumOf { it.runs })
        val line = buildString {
            append(plural(runs, "run"))
            if (calls > 0) append(", $calls of them workflow call${if (calls == 1) "" else "s"}")
            done?.let { append(" · $it% done") }
            append(" · ${costText(groups.sumOf { it.costUsd })}")
            append(" · ${groups.sumOf { it.movedOn }} moved on")
            noSize?.let { append(" · $it% without a size") }
        }
        val outside = sections.tiered.count { it.outsideRuns > 0 }
        return line to if (outside == 0) null
            else "${if (outside == 1) "1 model" else "$outside models"} ran outside ${if (outside == 1) "its tier" else "their tiers"}"
    }

    private fun routed(tier: String) = tier != "named" && tier != "not-routed"

    /** The report's subagents; a body that is not the report (an older server's 404 page, a list) reads as none. */
    fun decode(body: JsonElement): List<SubagentReportGroup> = ((body as? JsonObject)?.list("subagents")).orEmpty().mapNotNull { row ->
        val tier = row.str("tier")?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
        SubagentReportGroup(tier, row.str("provider"), row.str("providerLabel"), row.str("model"), row.str("modelLabel"),
            row.int("runs") ?: 0, row.int("workflowCalls") ?: 0, row.int("ended") ?: 0, row.int("done") ?: 0,
            row.dbl("costUsd") ?: 0.0, row.int("movedOn") ?: 0, row.int("noSize") ?: 0)
    }

    private fun rowKey(provider: String?, model: String?) = "${provider.orEmpty()}\n${model.orEmpty()}"

    private fun sum(groups: List<SubagentReportGroup>) = RunFigures(groups.sumOf { it.runs }, groups.sumOf { it.ended },
        groups.sumOf { it.done }, groups.sumOf { it.costUsd }, groups.sumOf { it.movedOn })

    private data class Listed(val provider: SubagentProvider, val model: SubagentTierModel, val order: Int)

    /**
     * The tier list and the report, joined on provider slug and model id (web routingSections): a report row names the provider and
     * model routing picked, which are the tier list's slug and model.
     */
    fun sections(providers: List<SubagentProvider>, groups: List<SubagentReportGroup>): RoutingSections {
        val listed = LinkedHashMap<String, Listed>()
        for (provider in providers) for (model in provider.models) {
            val key = rowKey(provider.slug, model.model)
            if (key !in listed) listed[key] = Listed(provider, model, listed.size)
        }
        val routed = LinkedHashMap<String, MutableList<SubagentReportGroup>>()
        val named = LinkedHashMap<String, MutableList<SubagentReportGroup>>()
        val notRouted = LinkedHashMap<String, MutableList<SubagentReportGroup>>()
        for (group in groups) {
            val into = when (group.tier) { "named" -> named; "not-routed" -> notRouted; else -> routed }
            into.getOrPut(rowKey(group.provider, group.model)) { mutableListOf() } += group
        }

        fun row(key: String, picked: List<SubagentReportGroup>): RoutingModelRow {
            val entry = listed[key]
            val first = picked.firstOrNull()
            val levels = entry?.model?.levels
            val tiers = Subagents.LEVELS.mapNotNull { tier ->
                val at = picked.filter { it.tier == tier }
                // A model the list no longer has cannot be said to be outside its tier.
                if (at.isEmpty()) null else TierRuns(tier, sum(at), levels != null && tier !in levels)
            }
            return RoutingModelRow(key, entry?.provider, entry?.model,
                modelLabel = first?.modelLabel ?: entry?.model?.model ?: "No model",
                providerLabel = entry?.provider?.label ?: first?.providerLabel,
                figures = sum(picked), tiers = tiers, outsideRuns = tiers.filter { it.outside }.sumOf { it.runs })
        }
        fun order(key: String) = listed[key]?.order ?: Int.MAX_VALUE
        val byRuns = compareByDescending<RoutingModelRow> { it.runs }.thenBy { order(it.key) }

        val tiered = mutableListOf<RoutingModelRow>()
        val idle = mutableListOf<RoutingModelRow>()
        for ((key, entry) in listed) {
            if (key in routed) continue
            val ranAtAll = key in named || key in notRouted
            if (entry.model.levels.isNotEmpty()) tiered += row(key, emptyList())
            else if (!ranAtAll) idle += row(key, emptyList())
        }
        for ((key, picked) in routed) tiered += row(key, picked)
        fun rest(map: Map<String, List<SubagentReportGroup>>) = map.map { (key, picked) -> row(key, picked) }.sortedWith(byRuns)
        return RoutingSections(tiered.sortedWith(byRuns), rest(named), rest(notRouted), idle)
    }
}
