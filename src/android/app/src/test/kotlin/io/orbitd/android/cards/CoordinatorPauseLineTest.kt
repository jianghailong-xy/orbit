package io.orbitd.android.cards

import io.orbitd.android.core.cards.CoordinatorQueue
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant
import java.time.ZoneId

/**
 * The waiting card's paused line (project 34cygPTQe5LPUT7tdUAzG) in the project's words, read off the coordinator's own session:
 * the quota window judged as the conversation's quota row judges it (`EngineErrors`), the reset or retry time in the receipts' clock.
 */
class CoordinatorPauseLineTest {
    private val zone = ZoneId.of("Asia/Shanghai")
    private val now = Instant.parse("2026-10-09T12:00:00Z")
    private val today = "2026-10-09T13:05:00Z"
    private val laterDay = "2026-10-12T11:00:00Z"
    private fun line(vararg fields: Pair<String, String?>) = coordinatorPauseLine(buildJsonObject {
        fields.forEach { (key, value) -> put(key, value) }
    }, now, zone)
    private fun failed(error: String?, retryAt: String? = null, lastReply: String? = null) =
        line("status" to "FAILED", "runState" to "FAILED", "error" to error, "retryAt" to retryAt, "lastAssistantText" to lastReply)

    @Test fun aSpentQuotaNamesItsWindowAndWhenItResets() {
        assertEquals("Coordinator paused · weekly limit · resets 10/12 19:00",
            failed("You've hit your weekly limit · resets Oct 12, 7pm (Asia/Shanghai)", laterDay))
        assertEquals("Coordinator paused · 5-hour limit · resets 21:05",
            failed("You've hit your session limit · resets 9:05pm (Asia/Shanghai)", today))
        assertEquals("Coordinator paused · usage limit · resets 21:05", failed("You've hit your usage limit.", today))
        assertEquals("no retry armed: no time", "Coordinator paused · weekly limit", failed("You've hit your weekly limit · resets Oct 12, 7pm"))
    }

    @Test fun anyOtherFailureSaysWhenItRetriesOrNothing() {
        assertEquals("Coordinator paused · retries 21:05", failed("API Error: 529 {\"type\":\"overloaded_error\"}", today))
        assertEquals("Coordinator paused", failed("runner went offline"))
        assertEquals("Coordinator paused", failed(null))
        assertEquals("a sentence quoting a limit is not one", "Coordinator paused · retries 21:05",
            failed("The tests passed, and I noticed earlier that you've hit your weekly limit on another account.", today))
    }

    /** A usage limit can park a retry without failing the run: its reply says which window. A failed run's own error comes first, so an
     * older reply does not name a limit the run did not hit. */
    @Test fun aParkedRetryReadsTheLastReplyAndAFailedRunItsError() {
        assertEquals("Coordinator paused · weekly limit · resets 10/12 19:00", line("status" to "AWAITING_INPUT", "runState" to "AWAITING_INPUT",
            "retryAt" to laterDay, "lastAssistantText" to "You've hit your weekly limit · resets Oct 12, 7pm (Asia/Shanghai)"))
        assertEquals("Coordinator paused", failed("runner went offline", lastReply = "You've hit your weekly limit · resets Oct 12, 7pm"))
        assertEquals("Coordinator paused · weekly limit", failed(" ", lastReply = "You've hit your weekly limit · resets Oct 12, 7pm"))
    }

    @Test fun aCoordinatorNoLongerPausedGetsItWhenItsTurnEnds() {
        assertEquals("Coordinator is back · it gets this when its current turn ends", line("status" to "AWAITING_INPUT", "runState" to "AWAITING_INPUT"))
        assertEquals(CoordinatorQueue.back, line("status" to "RUNNING", "runState" to "RUNNING", "lastAssistantText" to "You've hit your weekly limit"))
        assertEquals(CoordinatorQueue.back, line())
    }

    /** The rest of the card's words, as the project spells them for every client. */
    @Test fun theCardsWordsAreTheProjects() {
        assertEquals("Waiting for the coordinator", CoordinatorQueue.title)
        assertEquals("It goes to the coordinator when it’s back. You can still decide now.", CoordinatorQueue.explanation)
        assertEquals("It gets this when it’s back. Decide here only if you don’t want to wait.", CoordinatorQueue.decideHere)
        assertEquals("Sent to the coordinator · 20:05", CoordinatorQueue.sentLine("20:05"))
    }
}
