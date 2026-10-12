package io.orbitd.android.core.cards

import kotlinx.serialization.json.JsonObject

/** OrbitAskPreview.swift's server-count wording; no local scheduling guesses. The sentences are [BatchReview.impactRows]', so the
 * line a preview shows and the rows a review draws cannot drift apart. */
fun batchImpactLines(preview: JsonObject): List<String> = BatchReview.impactRows(preview).map { it.text }
