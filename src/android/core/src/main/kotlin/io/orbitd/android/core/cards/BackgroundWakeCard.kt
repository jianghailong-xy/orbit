package io.orbitd.android.core.cards

import kotlinx.serialization.json.JsonObject
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * What a scheduled wakeup's turn reads as on screen (A08-11; OrbitKit `BackgroundWakeCard`, web `BackgroundWakeCard.tsx`): one line in the
 * agent's stream saying a wakeup came due, why it was asked for and when — with the details label beside it — and folded under it the
 * wakeup's row, who queued the turn and what the agent received. A background job's end, new output or stall draws no line any more
 * (board C1, file 350t1lTONlrPMjilBdXx7): the job is one card from start to end ([BgJob]), and only a wakeup that came due beside it is
 * drawn ([BgJob.wakeupsOnly]). The source is [backgroundWake]'s projection of the control plane's note.
 */
object BackgroundWakeCard {
    /** How much of a scheduled wakeup's prompt is shown before folding the rest away. */
    const val tailLines = 8
    const val undelivered = "The session has not confirmed it received this."
    const val rawSummary = "What the agent received"
    // The words iOS and the web draw on the card itself, in English since bab3256a7 (`BackgroundWakeCopyParityTests`).
    const val details = "Details"
    const val title = "Scheduled wakeup"
    const val meta = "Queued by a scheduled wakeup, not typed by you"
    const val readInThisTurn = "Read in this turn"
    const val readInThisTurnHere = "Read in this turn"

    fun jobs(wake: JsonObject) = wake.objects("jobs")
    fun wakeups(wake: JsonObject) = wake.objects("wakeups")

    /** What the line names after its title: why the wakeup was asked for. */
    fun lineName(wake: JsonObject): String? = wakeups(wake).firstOrNull()?.text("reason")?.takeIf { it.isNotEmpty() }

    /** Whether a turn is only a note: no words, no files, and a note this client could not read as anything else — the note alone, never
     * an empty row in the reader's name (OrbitKit `drawsNoteAlone`, web `Transcript.tsx`'s fallback before `UserBubble`). */
    fun drawsNoteAlone(words: String, hasAttachments: Boolean, note: String?, queued: Boolean): Boolean =
        !queued && !note.isNullOrBlank() && words.isBlank() && !hasAttachments

    /** "Asked for 1h out · came due 4m ago". */
    fun wakeupMeta(wakeup: JsonObject, now: Instant = Instant.now()): String = buildList {
        wakeup.number("delaySeconds")?.let { add("Asked for ${duration(it.toLong())} out") }
        wakeup.text("dueAt")?.let { relative(it, now) }?.let { add("came due $it") }
    }.joinToString(" · ")

    /** How far a wake written into the running turn has got, in a steer's words (OrbitKit `SteerDelivery.state`) — null for every
     * other wake, and for one that never arrived, which [undelivered] says instead. */
    fun steerState(steer: Boolean, delivery: String?, undelivered: Boolean): String? {
        if (!steer || undelivered || delivery == "failed" || delivery == "unconfirmed") return null
        return when (delivery) {
            "written" -> "Waiting to be read"
            "acknowledged" -> readInThisTurn
            "requeued" -> "Queued for next turn instead"
            else -> "Sending…"
        }
    }

    /** The receipt as this card says it: the delivery's own words, the confirmed one included, as iOS and the web say it (bab3256a7). */
    fun steerReceipt(state: String?) = if (state == readInThisTurn) readInThisTurnHere else state

    /** "8s", "12m", "2h 5m", "3d" — a span (OrbitKit `WatchProjection.duration`). */
    fun duration(seconds: Long): String {
        val s = maxOf(0L, seconds)
        if (s < 60) return "${maxOf(1L, s)}s"
        if (s < 3_600) return "${s / 60}m"
        if (s < 86_400) {
            val h = s / 3_600; val m = (s % 3_600) / 60
            return if (h < 6 && m > 0) "${h}h ${m}m" else "${h}h"
        }
        val d = s / 86_400; val h = (s % 86_400) / 3_600
        return if (d < 3 && h > 0) "${d}d ${h}h" else "${d}d"
    }

    /** "just now", "12m ago", … "9/15" (OrbitKit `RelativeTime.format`). */
    fun relative(iso: String, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault()): String? {
        val at = runCatching { Instant.parse(iso) }.getOrNull() ?: return null
        val diff = Duration.between(at, now).seconds.toDouble()
        return when {
            diff < 60 -> "just now"
            diff < 3_600 -> "${(diff / 60).toInt()}m ago"
            diff < 86_400 -> "${(diff / 3_600).toInt()}h ago"
            diff < 604_800 -> "${(diff / 86_400).toInt()}d ago"
            diff < 4 * 604_800 -> "${(diff / 604_800).toInt()}w ago"
            else -> DateTimeFormatter.ofPattern("M/d", Locale.ROOT).format(at.atZone(zone))
        }
    }
}
