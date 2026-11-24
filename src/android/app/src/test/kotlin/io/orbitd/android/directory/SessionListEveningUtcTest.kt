package io.orbitd.android.directory

import java.time.Instant
import java.time.ZoneId
import org.junit.Assert.assertEquals
import org.junit.Test

/** Fixed clock, explicit zone: the day sections and the row time do not depend on the host's time zone or the wall clock. At 19:33Z
 * Asia/Shanghai is already on the next day, which is where these two scenarios once failed their release build. */
class SessionListEveningUtcTest {
    private val now = Instant.parse("2026-11-23T19:33:00Z")
    private fun s(id: String, listedAt: String) = DirectorySession(id, title = id, status = "AWAITING_INPUT", runState = "AWAITING_INPUT",
        createdAt = "2026-10-08T08:00:00Z", lastTurnAt = listedAt, listedAt = listedAt)

    private fun titles(zone: String) = directoryGroups(listOf(s("today", "2026-11-23T15:00:00Z"), s("older", "2026-11-20T19:33:00Z")),
        SessionView.OPEN, Grouping.RECENCY, now, ZoneId.of(zone)).map { it.title }

    @Test fun theOlderRowIsInTwoToSevenDaysUnderAnEveningUtcInstantInEitherZone() {
        // Shanghai is on 11-24 here (03:33): the 15:00Z row, 23:00 on 11-23 there, is Yesterday, the 11-20 row 4 days back.
        assertEquals(listOf("Yesterday", "2–7 days ago"), titles("Asia/Shanghai"))
        assertEquals(listOf("Today", "2–7 days ago"), titles("UTC"))
    }

    @Test fun theRowTimeIsTheElapsedTimeFromListedAtInEitherZone() {
        val prev = java.util.TimeZone.getDefault()
        try {
            for (zone in listOf("Asia/Shanghai", "UTC")) {
                java.util.TimeZone.setDefault(java.util.TimeZone.getTimeZone(zone))
                assertEquals(zone, "12m ago", SessionListTime.format(s("r", "2026-11-23T19:21:00Z"), now))
            }
        } finally { java.util.TimeZone.setDefault(prev) }
    }
}
