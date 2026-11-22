package io.orbitd.android.core.schedule

import io.orbitd.android.core.schedule.ScheduleDisplay.fill
import java.time.Instant

enum class ScheduleRunStatusKind { DIDNT_RUN, QUEUED_FULL, STARTED_ON }

/** The three states and their words, as in the web schedule run card. */
object ScheduleRunStatusDisplay {
    private val gaveUpStates = setOf("MISSED", "CANCELLED", "SKIPPED")

    fun kind(run: ScheduleRunView, status: ScheduleRunSessionStatus?): ScheduleRunStatusKind? {
        val mine = status?.currentTry ?: return null
        if (mine.reachedEngine) return null
        if (status.gaveUpAt != null && run.state in gaveUpStates) return ScheduleRunStatusKind.DIDNT_RUN
        if (status.queue != null && run.state == "RUNNING") return ScheduleRunStatusKind.QUEUED_FULL
        val later = status.tries.getOrNull(runTryIndex(run, status))
        return ScheduleRunStatusKind.STARTED_ON.takeIf { later?.reachedEngine == true }
    }

    private fun runTryIndex(run: ScheduleRunView, status: ScheduleRunSessionStatus): Int {
        val id = run.sessionId?.let(::scheduleIdKey) ?: return -1
        return status.tries.indexOfFirst { scheduleIdKey(it.sessionId) == id }
    }

    fun strip(run: ScheduleRunView, accessLevel: String, zone: String): String =
        fill(ScheduleRunStatusCopy.strip, mapOf("planned" to clock(run.plannedAt, zone),
            "access" to ScheduleDisplay.accessCopy(accessLevel).label))

    data class Text(val title: String, val body: String, val times: List<String> = emptyList(),
        val gaveUp: String? = null, val next: String? = null)

    fun didntRun(run: ScheduleRunView, status: ScheduleRunSessionStatus, runner: String, now: Instant, zone: String): Text {
        val copy = ScheduleRunStatusCopy.DidntRun
        val tries = status.tries.size
        val reason = when (run.failureReason) {
            "RUNNER_FULL" -> copy.full
            "CANCELLED_BY_OWNER" -> copy.cancelled
            "QUOTA" -> copy.quota
            "ENGINE_CRASHED_BEFORE_START" -> if (tries > 1) copy.engineFailed else copy.engineFailedOnce
            else -> if (tries > 1) copy.notPickedUp else copy.notPickedUpOnce
        }
        val next = status.nextDueAt?.let(ScheduleDisplay::parse)?.let { at ->
            fill(copy.nextRun, mapOf("when" to lowerDay(ScheduleDisplay.whenText(at, now, zone))))
        }
        return Text(copy.title, fill(reason, mapOf("runner" to runner, "tries" to tries.toString())) + " " + copy.nothingChanged,
            times = status.tries.map { clock(it.startedAt, zone) },
            gaveUp = status.gaveUpAt?.let { fill(copy.gaveUp, mapOf("time" to clock(it, zone))) },
            next = next)
    }

    fun queued(tag: String, body: String, waited: String?, deadline: String, now: Instant, zone: String): Text {
        val copy = ScheduleRunStatusCopy.Queued
        val at = ScheduleDisplay.parse(deadline)
        val whenText = at?.let {
            val time = ScheduleDisplay.localParts(it, zone).time
            val day = ScheduleDisplay.dayText(it, now, zone)
            if (day == ScheduleCopy.Dates.today) time else "$time ${lowerDay(day)}"
        }
        return Text(fill(copy.title, mapOf("tag" to tag)), body, next = whenText?.let {
            fill(if (waited == null) copy.givesUp else copy.waited, mapOf("waited" to waited.orEmpty(), "deadline" to it))
        })
    }

    fun startedOn(run: ScheduleRunView, status: ScheduleRunSessionStatus, engine: String, runner: String, zone: String): Text? {
        val mine = status.currentTry ?: return null
        val index = runTryIndex(run, status)
        val started = status.tries.getOrNull(index) ?: return null
        val copy = ScheduleRunStatusCopy.StartedOn
        val why = if (mine.claimed) fill(copy.engineExited, mapOf("engine" to engine))
            else fill(copy.notPickedUp, mapOf("runner" to runner))
        val values = mapOf("try" to (index + 1).toString(), "why" to why, "time" to clock(started.startedAt, zone))
        return Text(fill(copy.title, values), fill(copy.body, values))
    }

    private fun clock(value: String, zone: String): String =
        ScheduleDisplay.parse(value)?.let { ScheduleDisplay.localParts(it, zone).time }.orEmpty()

    private fun lowerDay(text: String): String {
        val dates = ScheduleCopy.Dates
        return when {
            text.startsWith(dates.today) -> dates.todayLower + text.removePrefix(dates.today)
            text.startsWith(dates.tomorrow) -> dates.tomorrowLower + text.removePrefix(dates.tomorrow)
            else -> text
        }
    }
}
