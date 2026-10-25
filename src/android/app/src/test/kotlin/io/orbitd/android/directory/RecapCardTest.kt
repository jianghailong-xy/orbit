package io.orbitd.android.directory

import java.io.File
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The conversation's Recap card ([RecapCard]; OrbitKit's `RecapCard`): when a conversation is at rest for it, what it says about
 * when the recap was written, what a refresh that wrote nothing says, and its words — held to RecapCard.swift word for word. */
class RecapCardTest {
    private val now = Instant.parse("2026-10-22T10:00:00Z")
    private val utc = ZoneId.of("UTC")
    private val recap = "Moved the recap onto the list row; the three states are covered by tests."
    private fun session(status: String = "AWAITING_INPUT", pendingApprovals: Int = 0, runningBgCount: Int? = null,
        runningSubagentCount: Int? = null, engineTurnActive: Boolean? = null, lifecycleState: String? = null,
        recapText: String? = recap, recapAt: String? = null) =
        DirectorySession("s", "t", status = status, pendingApprovals = pendingApprovals, runningBgCount = runningBgCount,
            runningSubagentCount = runningSubagentCount, engineTurnActive = engineTurnActive, lifecycleState = lifecycleState,
            recapText = recapText, recapAt = recapAt)
    private fun card(s: DirectorySession, recaps: Boolean = true) = RecapCard.make(s, recaps, now, utc)

    @Test fun aConversationAtRestEndsInItsRecap() {
        assertEquals(RecapCard(recap, null), card(session()))
        // A process it left running, or a run that ended, is no turn of its own: still at rest.
        assertNotNull(card(session(runningBgCount = 1)))
        assertNotNull(card(session(status = "SUCCEEDED")))
    }

    @Test fun workInHandKeepsTheCardAway() {
        assertNull("generating", card(session(status = "RUNNING")))
        assertNull("a turn it started itself", card(session(engineTurnActive = true)))
        assertNull("queued", card(session(status = "PENDING")))
        assertNull("waiting on you", card(session(pendingApprovals = 1)))
        assertNull("an agent it started", card(session(runningSubagentCount = 1)))
    }

    @Test fun noCardWithoutARecapOrWithRecapsOff() {
        assertNull(card(session(recapText = null)))
        assertNull(card(session(recapText = "   ")))
        assertNull("the Session recaps switch governs the card too", card(session(), recaps = false))
        assertNull(card(session(lifecycleState = "TRASH")))
    }

    @Test fun whenSaysAClockTimeTodayAndTheDateOnAnotherDay() {
        val clock = DateTimeFormatter.ofPattern("h:mm a", Locale.US).withZone(utc)
        val day = DateTimeFormatter.ofPattern("EEE, MMM d", Locale.US).withZone(utc)
        val today = "2026-10-22T09:41:00Z"
        assertEquals(clock.format(Instant.parse(today)), RecapCard.whenWritten(today, now, utc))
        val old = "2026-10-17T05:44:00Z"
        assertEquals("${day.format(Instant.parse(old))}, ${clock.format(Instant.parse(old))}", RecapCard.whenWritten(old, now, utc))
        assertNull(RecapCard.whenWritten(null, now, utc))
        assertEquals(clock.format(Instant.parse(today)), card(session(recapAt = today))?.whenWritten)
    }

    @Test fun aRefreshThatWroteNothingSaysWhy() {
        assertEquals(RecapCard.Notice(RecapCardCopy.upToDate, false), RecapCard.notice("no-events"))
        assertEquals(RecapCard.Notice(RecapCardCopy.tooLittle, false), RecapCard.notice("too-few-events"))
        assertEquals(RecapCard.Notice(RecapCardCopy.unavailable, false), RecapCard.notice("no-key"))
        assertEquals(RecapCard.Notice(RecapCardCopy.unavailable, false), RecapCard.notice("disabled"))
        assertEquals(RecapCard.Notice(RecapCardCopy.failed, true), RecapCard.notice("llm-failed"))
        assertEquals(RecapCard.Notice(RecapCardCopy.failed, true), RecapCard.notice("error"))
        assertNull("another pass wrote first: reading again shows its line", RecapCard.notice("cas-lost"))
    }

    /** Every word of [RecapCardCopy] is declared, under the same name, in OrbitKit's RecapCard.swift — and nothing more is. */
    @Test fun everyWordIsTheSwiftCardsWord() {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
            .first { File(it, "src/macos/OrbitKit/Sources/OrbitKit").isDirectory }
        val swift = File(root, "src/macos/OrbitKit/Sources/OrbitKit/App/RecapCard.swift").readText()
        val words = RecapCardCopy::class.java.declaredFields.filter { it.type == String::class.java }
            .associate { it.isAccessible = true; it.name to it.get(null) as String }
        assertEquals(6, words.size)
        words.forEach { (name, value) ->
            assertTrue("RecapCard.swift no longer declares $name as \"$value\"", swift.contains("public static let $name = \"$value\""))
        }
    }
}
