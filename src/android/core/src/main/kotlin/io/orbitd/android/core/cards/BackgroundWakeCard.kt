package io.orbitd.android.core.cards

import kotlinx.serialization.json.JsonObject
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * What a background wake reads as on screen (A08-11; OrbitKit `BackgroundWakeCard`, web `BackgroundWakeCard.tsx`): one line in the
 * agent's stream saying what happened, which job, how it came out and when — with the details label beside it — and folded under it
 * a row per job or wakeup, who queued the turn and what the agent received. A failed job's output tail stays out of the fold, folded
 * to three rendered lines. The source is [backgroundWake]'s projection of the control plane's note.
 */
object BackgroundWakeCard {
    /** How much of a scheduled wakeup's prompt is shown before folding the rest away. */
    const val tailLines = 8
    const val undelivered = "The session has not confirmed it received this."
    const val rawSummary = "What the agent received"
    // The words iOS and the web draw on the card itself in Chinese (iOS dfd3224a4, `BackgroundWakeCopyParityTests`).
    const val details = "详情"
    const val jobDetails = "任务详情"
    const val outputTail = "输出末尾"
    const val expandOutput = "展开输出"
    const val collapseOutput = "收起输出"
    const val sentIntoThisTurn = "Sent into this turn"
    const val sentIntoThisTurnHere = "已送达当前轮次"

    fun jobs(wake: JsonObject) = wake.objects("jobs")
    fun wakeups(wake: JsonObject) = wake.objects("wakeups")

    fun isFailed(job: JsonObject) = job.text("status") in setOf("failed", "killed")
    /** The line's mark is the clock: a wakeup, or a job that has only written something. */
    fun isPending(wake: JsonObject) = jobs(wake).none(::isFailed) && (jobs(wake).isEmpty() || jobs(wake).any { !it.flag("ended") })

    fun title(wake: JsonObject): String {
        val jobs = jobs(wake)
        val only = jobs.firstOrNull() ?: return "Scheduled wakeup"
        if (jobs.size > 1) return "${jobs.size} background jobs finished"
        if (!only.flag("ended")) return "Background job has new output"
        return if (isFailed(only)) "Background job failed" else "Background job finished"
    }

    /** How one job came out, as the word its row closes on — null while it has only written something. */
    fun status(job: JsonObject): String? {
        if (job.text("status") == "killed") return job.text("killReason")?.takeIf { it.isNotEmpty() }?.let { "killed: $it" } ?: "killed"
        job.number("exitCode")?.let { return "exit $it" }
        return if (job.flag("ended")) job.text("status") else null
    }

    fun name(job: JsonObject): String = job.text("description")?.takeIf { it.isNotEmpty() } ?: job.text("command").orEmpty()

    /** What the line names after its title: the one job, or why the wakeup was asked for. */
    fun lineName(wake: JsonObject): String? {
        val jobs = jobs(wake)
        if (jobs.size == 1) return name(jobs.single())
        if (jobs.isNotEmpty()) return null
        return wakeups(wake).firstOrNull()?.text("reason")?.takeIf { it.isNotEmpty() }
    }

    /** The one job's word, or how many of several failed. */
    fun lineStatus(wake: JsonObject): String? {
        val jobs = jobs(wake)
        if (jobs.size == 1) return status(jobs.single())
        val failed = jobs.filter(::isFailed)
        return if (failed.isEmpty()) null else "${failed.size} of ${jobs.size} failed"
    }

    /** The details label the line ends on, before its chevron: a wakeup's, or a job's. */
    fun detailsLabel(wake: JsonObject) = if (jobs(wake).isEmpty()) details else jobDetails

    /** "bgj_13c53745a88a · 16.2 KB of output". */
    fun jobMeta(job: JsonObject): String {
        val id = job.text("id").orEmpty()
        val to = job.number("outputTo") ?: return id
        return "$id · ${if (to == 0) "no output" else "${formatBytes(to)} of output"}"
    }

    fun formatBytes(n: Int): String = when {
        n < 1024 -> "$n B"
        n < 1024 * 1024 -> String.format(Locale.ROOT, "%.1f KB", n / 1024.0)
        else -> String.format(Locale.ROOT, "%.1f MB", n / (1024.0 * 1024.0))
    }

    /** "Asked for 1h out · came due 4m ago". */
    fun wakeupMeta(wakeup: JsonObject, now: Instant = Instant.now()): String = buildList {
        wakeup.number("delaySeconds")?.let { add("Asked for ${duration(it.toLong())} out") }
        wakeup.text("dueAt")?.let { relative(it, now) }?.let { add("came due $it") }
    }.joinToString(" · ")

    /** Who queued the turn, said in the fold; when is on the line itself. */
    fun meta(wake: JsonObject) = if (jobs(wake).isEmpty()) "Queued by a scheduled wakeup, not typed by you" else "Queued by a background job, not typed by you"

    /** How far a wake written into the running turn has got, in a steer's words (OrbitKit `SteerDelivery.state`) — null for every
     * other wake, and for one that never arrived, which [undelivered] says instead. */
    fun steerState(steer: Boolean, delivery: String?, undelivered: Boolean): String? {
        if (!steer || undelivered || delivery == "failed" || delivery == "unconfirmed") return null
        return when (delivery) {
            "written" -> "Delivering…"
            "acknowledged" -> sentIntoThisTurn
            "requeued" -> "Queued for next turn instead"
            else -> "Sending…"
        }
    }

    /** The receipt as this card says it: the delivery's words kept, the confirmed one said in Chinese (iOS dfd3224a4). */
    fun steerReceipt(state: String?) = if (state == sentIntoThisTurn) sentIntoThisTurnHere else state

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
