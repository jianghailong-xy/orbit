package io.orbitd.android.core.cards

import java.time.Instant
import java.time.ZoneId
import java.util.Locale
import kotlinx.serialization.json.JsonObject

/**
 * The evidence card's revision line, and when that revision was submitted (board evidence-waits-for-coordinator:
 * `submitted 7:59 PM`; web `evidenceSubmittedLine`, OrbitKit `EvidenceDecisions.submittedLine`). The time is the
 * pending row's `submittedAt`, in the receipts' clock; a row without it, or with one that does not parse, shows
 * the revision alone.
 */
object EvidenceDecisionLine {
    fun revisionLine(row: JsonObject, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault(),
        locale: Locale = Locale.getDefault()): String {
        val revision = "Evidence revision ${row.text("evidenceRevision") ?: ""}"
        val time = row.text("submittedAt")?.let { OwnerReview.receiptTime(it, now, zone, locale) } ?: return revision
        return "$revision · submitted $time"
    }
}
