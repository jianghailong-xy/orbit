package io.orbitd.android.reader

import io.orbitd.android.core.net.ApiError
import io.orbitd.android.tasks.TaskRunHandoff
import org.junit.Assert.*
import org.junit.Test
import java.time.ZoneId
import java.time.ZonedDateTime

/** OrbitKit AutoRetryLogicTests and EngineErrorsTests' retry timing: what the auto-retry card says and offers across the states one
 * outage moves through — armed, firing, gave up — the two the reader causes (switched off, the session moving on), and A07-12's
 * continue when nothing of anybody's is left to re-send. */
class AutoRetryLogicTest {
    private val now = 1_000_000_000L
    private val quotaMsg = "You've hit your session limit · resets 6:20pm (Europe/Berlin)"
    private val apiMsg = "API Error: 529 {\"type\":\"overloaded_error\",\"message\":\"Overloaded\"}"
    private fun notice(quota: Boolean, stale: Boolean = false, afterUserMsg: Boolean = false) =
        AutoRetryNotice(if (quota) quotaMsg else apiMsg, quota, stale, afterUserMsg)
    private fun state(n: AutoRetryNotice, live: Boolean = true, retryAt: Long? = null, attempts: Int = 0, hasRetryText: Boolean = true,
        nothingToResend: Boolean = false, takenOver: TaskRunHandoff.Conflict? = null) =
        AutoRetryLogic.state(n, live, retryAt, attempts, "deepseek", "wikova", hasRetryText, nothingToResend, now, takenOver) { 0.0 }
    private val handedOver = TaskRunHandoff.readConflict(ApiError.parse(409, """{"code":"TASK_ALREADY_RUNNING","taskId":"5Tkrnx1kbOyLZdlRiVN4Og",
        "conflictingSessionId":"6vVUlXGyjjJEQtxymaTkCM","conflictingSessionStatus":"RUNNING"}""".encodeToByteArray()))!!

    @Test fun anArmedQuotaIsNeutralAndCountsDown() {
        val s = state(notice(true), retryAt = now + 660_000)
        assertTrue(s.armed); assertFalse(s.firing); assertFalse(s.needsYou)
        assertEquals("5-hour limit reached", s.title)
        assertEquals("The 5-hour quota for deepseek on “wikova” is used up.", s.body)
        assertEquals("in 11 min", s.countdown)
        assertTrue(s.showsResetAt); assertFalse(s.showsMessage); assertTrue(s.showsAutoRow)
        assertEquals("Retry now anyway", s.retryNowTitle)
        assertEquals("The quota hasn’t reset yet — this will likely fail again.", s.retryNowNote)
    }

    @Test fun anArmedProviderErrorShowsTheErrorVerbatim() {
        val s = state(notice(false), retryAt = now + 30_000)
        assertEquals("Provider unavailable", s.title)
        assertEquals("The deepseek API could not answer — nothing about your message caused it.", s.body)
        assertTrue(s.showsMessage); assertFalse(s.showsResetAt)
        assertEquals("in 30 sec", s.countdown)
        assertEquals("Auto-retry — this usually clears", s.autoLabel)
    }

    @Test fun firingDropsTheManualRetry() {
        val s = state(notice(false), retryAt = now - 1_000)
        assertTrue(s.firing); assertFalse(s.armed); assertFalse(s.needsYou)
        assertNull(s.retryNowTitle); assertNull(s.countdown)
        assertEquals("Retrying — re-sending your message…", s.firingText)
    }

    @Test fun gaveUpEscalatesAndOffersNoSwitch() {
        val s = state(notice(false), attempts = 3)
        assertTrue(s.gaveUp); assertTrue(s.needsYou); assertFalse(s.canArm); assertFalse(s.showsAutoRow)
        assertEquals("Auto-retry gave up", s.title)
        assertEquals("Tried 3 times — the API is still failing. Over to you.", s.body)
        assertEquals("Retry now", s.retryNowTitle)
    }

    @Test fun switchedOffCanBePutBack() {
        val s = state(notice(true), attempts = 1)
        assertFalse(s.armed); assertTrue(s.needsYou); assertTrue(s.canArm); assertTrue(s.showsAutoRow)
        assertEquals("Off — nothing will re-send until you do.", s.autoDetail)
        assertNotNull(s.rearmAtMs)
        assertTrue(s.body.endsWith("Auto-retry is off."))
    }

    @Test fun noParsableResetMeansNoRearm() {
        val s = AutoRetryLogic.state(AutoRetryNotice("You've hit your usage limit. Try again later.", true, false, false), true, null, 0,
            "deepseek", "wikova", true, nowMs = now)
        assertNull(s.rearmAtMs); assertFalse(s.canArm); assertFalse(s.showsAutoRow)
    }

    @Test fun aStaleCardIsHistoryNotAnAlarm() {
        val s = state(notice(true, stale = true), live = false, retryAt = now + 600_000)
        assertFalse(s.armed); assertFalse(s.needsYou); assertFalse(s.showsAutoRow)
        assertNull(s.countdown); assertNull(s.retryNowTitle)
    }

    @Test fun theQuoteIsLeftOutWhenTheMessageIsRightAbove() {
        assertFalse(state(notice(true, afterUserMsg = true)).quotesRetryText)
        assertTrue(state(notice(true, afterUserMsg = false)).quotesRetryText)
        assertFalse("nothing to re-send", state(notice(true), hasRetryText = false).quotesRetryText)
    }

    /** A07-12 (iOS ceaf27657): a limit on a turn nobody sent — every verb is Continue, and the press says which sentence it sends. */
    @Test fun nothingToResendTurnsEveryVerbIntoAContinue() {
        val s = state(notice(true), hasRetryText = false, nothingToResend = true)
        assertTrue(s.continues); assertTrue(s.needsYou)
        assertEquals("5-hour limit reached", s.title)
        assertEquals("The 5-hour quota for deepseek on “wikova” is used up. Nothing to re-send — the limit landed on a turn that wasn’t yours.", s.body)
        assertEquals("Continue", s.retryNowTitle)
        assertEquals("Sends “Continue where you left off.”", s.retryNowNote)
        assertEquals("Continue when the quota resets", s.autoLabel)
        assertEquals("Off — nothing will continue until you do.", s.autoDetail)
        assertFalse(s.quotesRetryText)
    }

    @Test fun aProviderErrorWithNothingToResendAlsoContinues() {
        val s = state(notice(false), hasRetryText = false, nothingToResend = true)
        assertEquals("The deepseek API could not answer — nothing about your message caused it. Nothing to re-send — the failure landed on " +
            "a turn that wasn’t yours.", s.body)
        assertEquals("Continue — this usually clears", s.autoLabel)
        assertEquals("Continue", s.retryNowTitle)
        assertEquals("Continuing — picking up where it left off…",
            state(notice(false), retryAt = now - 1_000, hasRetryText = false, nothingToResend = true).firingText)
    }

    @Test fun anArmedContinueCountsDownInItsOwnWords() {
        val s = state(notice(true), retryAt = now + 3 * 3_600_000L, hasRetryText = false, nothingToResend = true)
        assertTrue(s.armed); assertFalse(s.needsYou); assertTrue(s.continues)
        assertEquals("in 3 hr", s.countdown)
        assertEquals("Continue now anyway", s.retryNowTitle)
        assertEquals("Runs on the server — you don't have to stay here.", s.autoDetail)
    }

    @Test fun aSpentContinueStillOffersItselfByHandAndAStaleOneOffersNothing() {
        val spent = state(notice(true), attempts = 5, hasRetryText = false, nothingToResend = true)
        assertTrue(spent.gaveUp); assertFalse(spent.showsAutoRow); assertEquals("Continue", spent.retryNowTitle)
        val stale = state(notice(true, stale = true), live = false, hasRetryText = false, nothingToResend = true)
        assertFalse(stale.continues); assertNull(stale.retryNowTitle); assertNull(stale.retryNowNote)
    }

    @Test fun aRetryThatMeetsANewerRunBecomesThatAnswer() {
        assertEquals("Retry now", state(notice(false)).retryNowTitle)
        val after = state(notice(false), takenOver = handedOver)
        assertEquals(TaskRunHandoff.heldTitle, after.takenOver?.title)
        assertEquals("6vVUlXGyjjJEQtxymaTkCM", after.takenOver?.sessionId)
        assertNull(after.retryNowTitle); assertNull(after.retryNowNote); assertFalse(after.quotesRetryText)
        assertFalse("re-sending is a promise another run makes false", state(notice(false), retryAt = now - 1_000, takenOver = handedOver).firing)
        assertNull("a stale card is history", state(notice(false, stale = true), live = false, takenOver = handedOver).takenOver)
    }

    @Test fun countdownWordingAndWindowNames() {
        assertEquals("in 27 sec", AutoRetryLogic.countdownText(27.0))
        assertEquals("in 1 sec", AutoRetryLogic.countdownText(0.4))
        assertEquals("in 2 min", AutoRetryLogic.countdownText(61.0))
        assertEquals("in 3 hr", AutoRetryLogic.countdownText(3 * 3600.0))
        assertEquals("in 3 days", AutoRetryLogic.countdownText(3 * 86_400.0))
        assertEquals("5-hour limit reached", AutoRetryLogic.quotaWindow("You've hit your session limit · resets 6pm (UTC)").first)
        assertEquals("Weekly limit reached", AutoRetryLogic.quotaWindow("You've hit your weekly limit · resets 1pm (UTC)").first)
        assertEquals("Usage limit reached", AutoRetryLogic.quotaWindow("You've hit your usage limit.").first)
    }

    @Test fun theProviderErrorLadderThenGivesUp() {
        assertEquals(now + 30_000, EngineErrors.apiErrorRetryAt(0, now) { 0.0 })
        assertEquals(now + 120_000, EngineErrors.apiErrorRetryAt(1, now) { 0.0 })
        assertEquals(now + 300_000, EngineErrors.apiErrorRetryAt(2, now) { 0.0 })
        assertNull(EngineErrors.apiErrorRetryAt(3, now) { 0.0 })
        assertEquals(3, EngineErrors.maxApiErrorRetries)
        val jittered = EngineErrors.apiErrorRetryAt(0, now) { 0.99 }!! - now
        assertTrue(jittered in 30_000..37_500)
    }

    private fun berlin(y: Int, mo: Int, d: Int, h: Int, mi: Int) = ZonedDateTime.of(y, mo, d, h, mi, 0, 0, ZoneId.of("Europe/Berlin")).toInstant().toEpochMilli()

    @Test fun theQuotasResetIsReadOutOfTheRuntimesOwnWords() {
        assertEquals(berlin(2026, 8, 12, 18, 20), EngineErrors.parseQuotaResetAt(quotaMsg, berlin(2026, 8, 12, 14, 0)))
        assertEquals("a time already past is tomorrow's", berlin(2026, 8, 13, 18, 20), EngineErrors.parseQuotaResetAt(quotaMsg, berlin(2026, 8, 12, 22, 0)))
        assertEquals(berlin(2026, 8, 3, 13, 0),
            EngineErrors.parseQuotaResetAt("You've hit your weekly limit · resets Aug 3, 1pm (Europe/Berlin)", berlin(2026, 8, 1, 9, 0)))
        assertNull(EngineErrors.parseQuotaResetAt("You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase " +
            "more credits or try again at Aug 9th, 2026 1:26 PM.", berlin(2026, 8, 12, 14, 0)))
        assertNull(EngineErrors.parseQuotaResetAt("resets 6:20pm (Mars/Olympus)", now))
        assertNull(EngineErrors.parseQuotaResetAt(null, now))
    }
}
