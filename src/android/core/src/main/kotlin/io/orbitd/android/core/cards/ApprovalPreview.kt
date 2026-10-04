package io.orbitd.android.core.cards

import kotlinx.serialization.json.JsonObject

/** OrbitAskPreview.swift's server-count wording; no local scheduling guesses. */
fun batchImpactLines(preview: JsonObject): List<String> = buildList {
    val starting = preview.number("startingNow") ?: 0
    val blocked = preview.number("blocked") ?: 0
    val manual = preview.number("needsManualStart") ?: 0
    val unavailable = preview.number("notDispatchable") ?: 0
    if (starting > 0) add("$starting start${if (starting == 1) "s" else ""} running within the minute")
    if (blocked > 0) add("$blocked wait${if (blocked == 1) "s" else ""} on a prerequisite")
    if (manual > 0) add("$manual need${if (manual == 1) "s" else ""} a manual start — nothing will trigger ${if (manual == 1) "it" else "them"}")
    if (unavailable > 0) add("$unavailable cannot run — unassigned, no runner, auto-run off, or the list is paused")
}
