package io.orbitd.android.reader

import io.orbitd.android.tasks.TaskRunHandoff
import kotlin.math.ceil

/** One auto-retry row of the transcript (OrbitKit `AutoRetryNotice`, projected by [EngineReading]): the runtime's own sentence,
 * which failure it is, whether the session went on past it, and whether the bubble it would re-send is the line right above. */
internal data class AutoRetryNotice(val message: String, val quota: Boolean, val stale: Boolean, val afterUserMsg: Boolean)

/**
 * What the auto-retry card shows (OrbitKit `AutoRetryLogic`, web `AutoRetryCard`): the transcript supplies the failure, the
 * session's detail the live retry (`retryAt`, `retryAttempts`), and this decides the words and which controls are offered.
 *
 * While a retry is armed the card stays neutral: the situation is handled. It asks for the reader only when the ball is back in
 * their court — no moment to retry at could be determined, the retries ran out, or they switched it off themselves.
 */
internal object AutoRetryLogic {
    /** What a continue sends — the card's button by hand, or the armed retry at the reset (shared `CONTINUE_MESSAGE`). */
    const val continueMessage = "Continue where you left off."

    /** How many attempts the server spends before handing back: a quota until its reset stops moving, a provider error the
     * shorter ladder of [EngineErrors.apiErrorRetryAt]. */
    fun maxAttempts(quota: Boolean) = if (quota) 5 else EngineErrors.maxApiErrorRetries

    data class State(
        val title: String,
        val body: String,
        /** The runtime's sentence verbatim: a provider error's is the one thing to act on if it recurs; a quota's the body restates. */
        val showsMessage: Boolean,
        /** A retry is pending and its moment is still ahead. */
        val armed: Boolean,
        /** Its moment has passed: the server is re-sending right now. */
        val firing: Boolean,
        val gaveUp: Boolean,
        /** Still open, and nothing is going to move it — the only state that earns the warning tint. */
        val needsYou: Boolean,
        val canArm: Boolean,
        /** Nothing of anybody's for a re-send to carry: every verb on the card is Continue. */
        val continues: Boolean,
        val firingText: String,
        /** "in 27 sec" / "in 11 min", while there is something to count down to. */
        val countdown: String?,
        /** A quota leads with the moment its window resets; a provider error's few minutes need no time of day. */
        val showsResetAt: Boolean,
        /** The switch row: shown while armed (to turn it off) or while it can be put back — off is drawn, not implied. */
        val showsAutoRow: Boolean,
        val autoLabel: String,
        val autoDetail: String,
        /** When the switch is flipped back on, the moment the re-armed retry fires; null when the runtime named none. */
        val rearmAtMs: Long?,
        /** The manual press's title, or null when there is nothing to re-send. */
        val retryNowTitle: String?,
        /** The caveat under a press that races an armed retry, or which sentence a continue sends. */
        val retryNowNote: String?,
        /** Quote what would be re-sent, unless that bubble is the line right above. */
        val quotesRetryText: Boolean,
        /** The answer a press got when the task had moved on to another run: shown where the press was. */
        val takenOver: TaskRunHandoff.Conflict?,
    )

    /**
     * @param live this card describes the current situation (not a settled outage, and a session to act through).
     * @param retryAtMs the server's armed retry, or null when nothing is armed.
     * @param attempts attempts already spent on this outage — what separates "never armed" from "gave up".
     * @param hasRetryText there is a message a manual retry could re-send.
     * @param nothingToResend the server answered there is nothing of anybody's to send: the card continues instead.
     */
    fun state(notice: AutoRetryNotice, live: Boolean, retryAtMs: Long?, attempts: Int, provider: String, runnerName: String?,
        hasRetryText: Boolean, nothingToResend: Boolean = false, nowMs: Long, takenOver: TaskRunHandoff.Conflict? = null,
        rand: () -> Double = { Math.random() }): State {
        val quota = notice.quota
        // Read once: the body, the labels and both controls branch on it, and must never disagree about the verb.
        val continues = live && nothingToResend
        val taken = if (live) takenOver else null
        val at = if (live) retryAtMs else null
        val leftMs = at?.let { it - nowMs } ?: 0
        val armed = at != null && leftMs > 0
        // "Re-sending your message…" is a promise, and false once another run has the task.
        val firing = at != null && leftMs <= 0 && taken == null
        val gaveUp = live && at == null && attempts >= maxAttempts(quota)
        val needsYou = live && !armed && !firing
        val window = quotaWindow(notice.message)
        val rearm = if (quota) EngineErrors.parseQuotaResetAt(notice.message, nowMs)
            else EngineErrors.apiErrorRetryAt(attempts, nowMs, rand)
        val canArm = live && !armed && !firing && !gaveUp && rearm != null

        val title = when { gaveUp -> "Auto-retry gave up"; quota -> window.first; else -> "Provider unavailable" }
        // Why there is no Retry, said where it would have been: the failure landed on a turn nobody sent.
        val nothingToSend = if (quota) "Nothing to re-send — the limit landed on a turn that wasn’t yours."
            else "Nothing to re-send — the failure landed on a turn that wasn’t yours."
        val body = when {
            gaveUp -> if (quota) "Tried $attempts times — the quota still reports as spent. Over to you."
                else "Tried $attempts times — the API is still failing. Over to you."
            quota -> {
                val on = runnerName?.let { if (it.isEmpty()) "" else " on “$it”" }.orEmpty()
                "${window.second} for $provider$on is used up." + when { continues -> " $nothingToSend"; needsYou -> " Auto-retry is off."; else -> "" }
            }
            else -> "The $provider API could not answer — nothing about your message caused it." +
                when { continues -> " $nothingToSend"; needsYou -> " Auto-retry is off."; else -> "" }
        }
        val offered = live && !firing && (hasRetryText || continues) && taken == null
        return State(
            title = title, body = body, showsMessage = !quota, armed = armed, firing = firing, gaveUp = gaveUp, needsYou = needsYou,
            canArm = canArm, continues = continues,
            firingText = if (continues) "Continuing — picking up where it left off…" else "Retrying — re-sending your message…",
            countdown = if (armed) countdownText(leftMs / 1000.0) else null,
            showsResetAt = quota, showsAutoRow = armed || canArm,
            autoLabel = if (continues) (if (quota) "Continue when the quota resets" else "Continue — this usually clears")
                else (if (quota) "Auto-retry when the quota resets" else "Auto-retry — this usually clears"),
            autoDetail = when { armed -> "Runs on the server — you don't have to stay here."
                continues -> "Off — nothing will continue until you do."; else -> "Off — nothing will re-send until you do." },
            rearmAtMs = rearm,
            retryNowTitle = if (!offered) null else if (armed) (if (continues) "Continue now anyway" else "Retry now anyway")
                else (if (continues) "Continue" else "Retry now"),
            retryNowNote = if (!offered) null else if (armed) (if (quota) "The quota hasn’t reset yet — this will likely fail again."
                else "The API may still be failing — this could fail again.") else if (continues) "Sends “$continueMessage”" else null,
            quotesRetryText = live && !firing && hasRetryText && !notice.afterUserMsg && taken == null,
            takenOver = taken,
        )
    }

    /** The window that ran out, in the runtime's own terms, titled by its length (the runtime's "session limit" would read as a
     * limit on the Orbit session). Codex names no window and falls through. */
    fun quotaWindow(message: String): Pair<String, String> {
        val m = message.lowercase()
        if ("hit your session limit" in m) return "5-hour limit reached" to "The 5-hour quota"
        if ("hit your weekly limit" in m) return "Weekly limit reached" to "The weekly quota"
        return "Usage limit reached" to "The quota"
    }

    /** "in 27 sec" / "in 11 min" / "in 2 hr" / "in 2 days": seconds matter, a provider-error retry is 30 seconds out. */
    fun countdownText(seconds: Double): String {
        if (seconds < 60) return "in ${maxOf(1, ceil(seconds).toInt())} sec"
        val min = ceil(seconds / 60).toInt()
        if (min < 60) return "in $min min"
        val hr = Math.round(min / 60.0).toInt()
        if (hr < 36) return "in $hr hr"
        return "in ${Math.round(hr / 24.0)} days"
    }
}
