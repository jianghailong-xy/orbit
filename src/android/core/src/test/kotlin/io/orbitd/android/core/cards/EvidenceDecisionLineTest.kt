package io.orbitd.android.core.cards

import java.time.Instant
import java.time.ZoneId
import java.util.Locale
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import org.junit.Assert.assertEquals
import org.junit.Test

class EvidenceDecisionLineTest {
    private val zone = ZoneId.of("Asia/Shanghai")
    private val now = Instant.parse("2026-10-09T13:00:00Z")
    private fun line(submittedAt: String?) = EvidenceDecisionLine.revisionLine(buildJsonObject {
        put("evidenceRevision", JsonPrimitive("4"))
        submittedAt?.let { put("submittedAt", JsonPrimitive(it)) }
    }, now, zone, Locale.US).replace(' ', ' ')

    @Test fun theRevisionLineSaysWhenItWasSubmitted() {
        assertEquals("Evidence revision 4 · submitted 7:59 PM", line("2026-10-09T11:59:30Z"))
        assertEquals("Evidence revision 4 · submitted 10/8 7:59 PM", line("2026-10-08T11:59:30Z"))
    }

    @Test fun aRowWithoutATimeShowsTheRevisionAlone() {
        assertEquals("Evidence revision 4", line(null))
        assertEquals("Evidence revision 4", line("not a time"))
    }
}
