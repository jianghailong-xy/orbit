package io.orbitd.android.core.cards

import kotlinx.serialization.json.JsonObject

/** Counts are server row counts, including replacement-chain deduplication. */
fun createdTasksCountLine(tasks: JsonObject): String = buildList {
    val running = tasks.number("running") ?: 0
    val failed = tasks.number("failed") ?: 0
    if (running > 0) add("$running running")
    if (failed > 0) add("$failed failed")
    add("${tasks.number("done") ?: 0}/${tasks.number("total") ?: 0} done")
}.joinToString(" · ")
