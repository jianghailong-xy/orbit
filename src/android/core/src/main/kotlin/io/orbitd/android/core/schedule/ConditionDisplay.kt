package io.orbitd.android.core.schedule

import java.time.Duration
import java.time.Instant
import java.util.Locale

/**
 * A WHEN rule's words as the shared `SCHEDULE_CONDITION_COPY` (src/shared/src/schedule.ts) says them, word for word
 * (ConditionDisplayTest reads that file): the When lines of a create card, and an envelope card for a new probe command. A port of
 * OrbitKit's `ScheduleConditionCopy`.
 */
object ScheduleConditionCopy {
    const val rulesShort = "{condition}"
    const val rulesLong = "When {condition}"
    const val held = "{condition} for {duration}"
    const val rearm = "Fires again only after it {rearm}."
    const val rearmWhenFalse = "Fires again once it no longer holds."
    val rearmOps: Map<String, String> = mapOf(
        "GT" to "goes above {value}",
        "GTE" to "reaches {value}",
        "LT" to "drops below {value}",
        "LTE" to "drops to {value}",
        "EQ" to "reads {value}",
        "EXIT_ZERO" to "succeeds again",
    )
    const val repeat = "And again every {interval} while it stays that way."
    val repeatUnits: Map<String, String> = mapOf("hour" to "hour", "hours" to "{count} hours", "minute" to "minute",
        "minutes" to "{count} minutes")
    const val checked = "Checked every {interval} on {runner}, no model."
    const val checkedNoRunner = "Checked every {interval}, no model."
    const val keepsAwake = "Keeps this cloud workspace awake while it waits."
    const val seconds = "{count} s"
    const val minutes = "{count} min"
    const val hours = "{count} h"
    const val keep = "Keep the approved command"
    const val commandNote = "It runs on its own, without a model, every time the condition is checked. Read it before you allow it."

    /** Every sentence above under its path in `SCHEDULE_CONDITION_COPY`: what the parity test reads. */
    val contract: Map<String, String> = buildMap {
        put("rules.short", rulesShort); put("rules.long", rulesLong); put("held", held); put("rearm", rearm)
        put("rearmWhenFalse", rearmWhenFalse); put("repeat", repeat); put("checked", checked); put("checkedNoRunner", checkedNoRunner)
        put("seconds", seconds); put("minutes", minutes); put("hours", hours); put("keep", keep); put("commandNote", commandNote)
        rearmOps.forEach { (k, v) -> put("rearmOps.$k", v) }
        repeatUnits.forEach { (k, v) -> put("repeatUnits.$k", v) }
    }
}

/**
 * The words the condition surfaces add on the clients (condition-triggers board ④ ⑤ ⑥ and frame 2): the Scheduled page's group and
 * readings, the inspector's Condition and How it checks blocks and history lines, a run's header, and the Waiting on you cards. iOS
 * is the reference (OrbitKit `ConditionCopy`); the web's `CONDITION_COPY` says the same words.
 */
object ConditionCopy {
    const val group = "Waiting for a condition"
    const val cantRead = "Can't read"
    /** A task row's second line: "Task · once, when 3 or more OSDs are in · HPC". */
    const val taskRow = "Task"
    const val taskOnce = "once, when {condition}"
    const val justNow = "just now"
    const val minutesAgo = "{count} min ago"
    const val hoursAgo = "{count} h ago"
    const val daysAgo = "{count} days ago"
    /** The inspector's reading: "checked 1 min ago". */
    const val checkedAgo = "checked {age}"
    const val notReadYet = "not read yet"
    const val conditionSection = "Condition"
    const val howItChecks = "How it checks"
    const val every = "Every {interval} on {runner}, without a model."
    const val everyNoRunner = "Every {interval}, without a model."
    const val approved = "Read-only. Approved by you on {date}."
    /** "Fires above 90%", then the hold (" for 10 min") and a full stop: the web's CONDITION_COPY.fires. */
    val fires: Map<String, String> = mapOf(
        "GT" to "Fires above {value}", "GTE" to "Fires at {value} or more", "LT" to "Fires below {value}",
        "LTE" to "Fires at {value} or less", "EQ" to "Fires at {value}", "EXIT_ZERO" to "Fires when the check succeeds",
    )
    const val holdFor = " for {duration}"
    /** "Ready again below 85%.": the web's CONDITION_COPY.readyAgain. */
    val readyAgain: Map<String, String> = mapOf(
        "GT" to "Ready again above {value}.", "GTE" to "Ready again at {value} or more.", "LT" to "Ready again below {value}.",
        "LTE" to "Ready again at {value} or less.", "EQ" to "Ready again at {value}.",
        "EXIT_ZERO" to "Ready again once the check succeeds.",
    )
    const val readyAgainWhenFalse = "Ready again once it no longer holds."
    /** The history's lines and their chips. */
    const val historyFired = "Fired · {reading}{hold}"
    const val historyFiredAgain = "Fired again · {reading}"
    const val historyReadyAgain = "Ready again · {reading}"
    const val historyCantRead = "Can't read"
    const val historyReadAgain = "Reads again · {reading}"
    const val historyAsked = "Asked whether to keep waiting"
    const val chipRun = "Run"
    const val chipCondition = "Condition"
    /** A run's session's header (board ⑤ ②): "Fired 03:12 · 90.4% for 10 min · Check only". */
    const val runFired = "Fired {time}"
    const val runFiredAgain = "Fired again {time}"
    /** Waiting on you (board ⑥ ①). */
    const val waitingKind = "Condition"
    const val pause = "Pause"
    const val lookIntoIt = "Look into it"
    const val keepWaiting = "Keep waiting"
    const val stop = "Stop"
    /** The task create card (board frame 2): its title and the three lines a startWhen adds. */
    const val createTaskTitle = "Create task that starts on a condition?"
    const val startsWhen = "Starts when"
    const val today = "Today"
    const val ifNever = "If never"

    /** Every sentence above, so the copy guard reads them as English. */
    val all: List<String> = listOf(
        group, cantRead, taskRow, taskOnce, justNow, minutesAgo, hoursAgo, daysAgo, checkedAgo, notReadYet,
        conditionSection, howItChecks, every, everyNoRunner, approved, holdFor, readyAgainWhenFalse, historyFired, historyFiredAgain,
        historyReadyAgain, historyCantRead, historyReadAgain, historyAsked, chipRun, chipCondition, runFired, runFiredAgain, waitingKind,
        pause, lookIntoIt, keepWaiting, stop, createTaskTitle, startsWhen, today, ifNever,
    ) + fires.values.sorted() + readyAgain.values.sorted()
}

/** The rules that turn a condition's reads into what the client draws: a port of OrbitKit's `ConditionDisplay`, function for
 * function. Pure, so it runs in `:core`'s unit tests. */
object ConditionDisplay {
    private fun fill(t: String, v: Map<String, String>) = ScheduleDisplay.fill(t, v)
    private val C = ConditionCopy
    private val CC = ScheduleConditionCopy

    // Readings

    /** A number as a reading says it: "2", "6.9", "90.4", at most two decimals (the server's `readingText`). */
    fun numberText(value: Double): String {
        if (value == Math.rint(value) && Math.abs(value) < 1e15) return value.toLong().toString()
        val rounded = Math.round(value * 100) / 100.0
        if (rounded == Math.rint(rounded)) return rounded.toLong().toString()
        return String.format(Locale.ROOT, "%.2f", rounded).trimEnd('0')
    }

    /** A reading with its unit: "6.9%", "2 in", "412 GiB". */
    fun readingText(value: Double, unit: String?): String {
        val n = numberText(value)
        if (unit.isNullOrEmpty()) return n
        return if (unit == "%") "$n%" else "$n $unit"
    }

    /** How old a reading is: "just now", "1 min ago", "3 h ago", "3 days ago". */
    fun ageText(at: Instant, now: Instant): String {
        val minutes = (maxOf(0L, Duration.between(at, now).seconds) / 60).toInt()
        if (minutes < 1) return C.justNow
        if (minutes < 60) return fill(C.minutesAgo, mapOf("count" to minutes.toString()))
        val hours = minutes / 60
        if (hours < 48) return fill(C.hoursAgo, mapOf("count" to hours.toString()))
        return fill(C.daysAgo, mapOf("count" to (hours / 24).toString()))
    }

    /** A row's reading where a timed row shows its time (board ④ ②): "6.9%" and "1 min ago". */
    data class RowReading(val value: String, val age: String?) {
        val text: String get() = listOfNotNull(value, age).joinToString(ScheduleCopy.separator)
    }

    /** Null before a first reading. */
    fun rowReading(value: Double?, unit: String?, at: String?, now: Instant): RowReading? {
        value ?: return null
        return RowReading(readingText(value, unit), at?.let(ScheduleDisplay::parse)?.let { ageText(it, now) })
    }

    fun rowReading(reading: ScheduleConditionReading, now: Instant): RowReading? =
        rowReading(reading.lastValue, reading.unit, reading.lastSampleAt, now)

    // The rows

    /** A WHEN schedule's or a waiting task's mark: the gauge in place of the circle, amber and "Can't read" when its probe cannot
     * be read. */
    fun circle(cantRead: Boolean): ScheduleDisplay.CircleView =
        if (cantRead) ScheduleDisplay.CircleView(ScheduleDisplay.Circle.held, null,
            ScheduleDisplay.Tag(ScheduleDisplay.TagTone.held, C.cantRead), gauge = true)
        else ScheduleDisplay.CircleView(ScheduleDisplay.Circle.open, gauge = true)

    /** A waiting task's second line: "Task · once, when 3 or more OSDs are in · HPC". */
    fun taskRowLine(task: ScheduleWaitingTask): String {
        val parts = mutableListOf(C.taskRow, fill(C.taskOnce, mapOf("condition" to ScheduleDisplay.lowerFirst(task.condition.text))))
        task.workspaceName?.takeIf { it.isNotEmpty() }?.let { parts += it }
        return parts.joinToString(ScheduleCopy.separator)
    }

    /** A task's waiting line (§6.2, Tasks): the server's "Waiting for: 3 or more OSDs are in", and the newest reading with its age
     * ("2 in · 3 min ago"); null once it fired or ended. */
    data class TaskWaiting(val line: String, val reading: String?)

    fun taskWaiting(startWhen: TaskStartWhenView?, now: Instant): TaskWaiting? {
        val line = startWhen?.waitingLine ?: return null
        val reading = if (startWhen.state == "UNKNOWN") C.cantRead
            else rowReading(startWhen.lastValue, startWhen.unit, startWhen.lastSampleAt, now)?.text
        return TaskWaiting(line, reading)
    }

    // The When lines (shared `scheduleWhenLines`)

    /** "10 min", "45 s", "2 h". */
    fun durationText(seconds: Int): String {
        if (seconds < 60) return fill(CC.seconds, mapOf("count" to seconds.toString()))
        if (seconds < 7200 || seconds % 3600 != 0) return fill(CC.minutes, mapOf("count" to Math.round(seconds / 60.0).toString()))
        return fill(CC.hours, mapOf("count" to (seconds / 3600).toString()))
    }

    /** "And again every 2 hours while it stays that way."; null with no repeat. */
    fun repeatText(seconds: Int?): String? {
        seconds ?: return null
        val interval = if (seconds % 3600 == 0) {
            if (seconds == 3600) CC.repeatUnits.getValue("hour") else fill(CC.repeatUnits.getValue("hours"), mapOf("count" to (seconds / 3600).toString()))
        } else {
            val minutes = Math.round(seconds / 60.0).toInt()
            if (minutes == 1) CC.repeatUnits.getValue("minute") else fill(CC.repeatUnits.getValue("minutes"), mapOf("count" to minutes.toString()))
        }
        return fill(CC.repeat, mapOf("interval" to interval))
    }

    /** A WHEN rule's lines worked out on the client, for a card from a server that sends none. */
    fun whenLines(condition: ScheduleWhenCondition, runner: String?, keepsWorkspaceAwake: Boolean = false): ScheduleWhenLines {
        val text = if (condition.holdSeconds > 0) fill(CC.held, mapOf("condition" to condition.text, "duration" to durationText(condition.holdSeconds)))
            else condition.text
        val r = condition.rearm
        val op = r?.let { CC.rearmOps[it.op] }
        val rearm = if (r != null && op != null) fill(CC.rearm, mapOf("rearm" to fill(op, mapOf("value" to (r.value?.let { readingText(it, condition.unit) } ?: "")))))
            else CC.rearmWhenFalse
        val interval = durationText(condition.intervalSeconds)
        val checked = runner?.let { fill(CC.checked, mapOf("interval" to interval, "runner" to it)) }
            ?: fill(CC.checkedNoRunner, mapOf("interval" to interval))
        return ScheduleWhenLines(text, "$rearm $checked", condition.command, repeatText(condition.repeatSeconds),
            if (keepsWorkspaceAwake) CC.keepsAwake else null)
    }

    /** The When line split for drawing: the condition in bold, the hold after it ("**Raw used above 90%** for 10 min"). */
    fun whenTextParts(lines: ScheduleWhenLines, condition: ScheduleWhenCondition?): Pair<String, String> {
        val text = condition?.text
        if (text == null || !lines.text.startsWith(text)) return lines.text to ""
        return text to lines.text.substring(text.length)
    }

    // The inspector (board ⑥ ② ③)

    /** "Fires above 90% for 10 min." */
    fun firingLine(compare: ConditionCompare, holdSeconds: Int, unit: String?): String {
        val hold = if (holdSeconds > 0) fill(C.holdFor, mapOf("duration" to durationText(holdSeconds))) else ""
        val template = C.fires[compare.op] ?: C.fires.getValue("EXIT_ZERO")
        return fill(template, mapOf("value" to (compare.value?.let { readingText(it, unit) } ?: ""))) + hold + "."
    }

    /** "Ready again below 85%." */
    fun rearmLine(rearm: ConditionCompare?, unit: String?): String {
        val template = rearm?.let { C.readyAgain[it.op] } ?: return C.readyAgainWhenFalse
        return fill(template, mapOf("value" to (rearm.value?.let { readingText(it, unit) } ?: "")))
    }

    /** The bar under the reading: where the reading, the firing line and the re-arm line sit on one scale (0…1). */
    data class Bar(val value: Double, val fire: Double, val fireLabel: String, val rearm: Double?, val rearmLabel: String?)

    /** The Condition block's lines: "6.9%" (null before a first reading), "checked 1 min ago", "Fires above 90% for 10 min. Ready
     * again below 85%.", the repeat, and "Can't read" while the probe cannot be read. */
    data class ConditionBlock(val reading: String?, val checked: String, val rule: String, val repeat: String?, val cantRead: String?,
        val bar: Bar?)

    fun bar(value: Double?, compare: ConditionCompare, rearm: ConditionCompare?, unit: String?): Bar? {
        val fire = compare.value
        if (compare.op == "EXIT_ZERO" || fire == null) return null
        val rearmValue = if (rearm?.op == "EXIT_ZERO") null else rearm?.value
        val most = maxOf(fire, rearmValue ?: 0.0, value ?: 0.0)
        val top = if (unit == "%" && most <= 100) 100.0 else most * 1.25
        if (top <= 0) return null
        fun at(v: Double) = minOf(1.0, maxOf(0.0, v / top))
        return Bar(at(value ?: 0.0), at(fire), readingText(fire, unit), rearmValue?.let(::at), rearmValue?.let { readingText(it, unit) })
    }

    fun conditionBlock(c: ConditionView, now: Instant): ConditionBlock {
        val at = (c.lastReadAt ?: c.lastSampleAt)?.let(ScheduleDisplay::parse)
        return ConditionBlock(
            reading = c.lastValue?.let { readingText(it, c.unit) },
            checked = at?.let { fill(C.checkedAgo, mapOf("age" to ageText(it, now))) } ?: C.notReadYet,
            rule = "${firingLine(c.compare, c.holdSeconds, c.unit)} ${rearmLine(c.rearm, c.unit)}",
            repeat = repeatText(c.repeatSeconds),
            cantRead = if (c.state == "UNKNOWN") C.cantRead else null,
            bar = bar(c.lastValue, c.compare, c.rearm, c.unit),
        )
    }

    /** The How it checks block: "Every 5 min on workstation-gpu, without a model.", the command, "Read-only. Approved by you on Nov
     * 17.", and on Orbit Cloud that it keeps the workspace awake. */
    data class ChecksBlock(val every: String, val command: String, val approved: String, val awake: String?)

    fun checksBlock(c: ConditionView, timezone: String): ChecksBlock {
        val interval = durationText(c.intervalSeconds)
        val every = c.runnerName?.let { fill(C.every, mapOf("interval" to interval, "runner" to it)) }
            ?: fill(C.everyNoRunner, mapOf("interval" to interval))
        val date = ScheduleDisplay.parse(c.approvedAt)?.let { ScheduleDisplay.dateText(it, timezone) } ?: ""
        return ChecksBlock(every, c.command, fill(C.approved, mapOf("date" to date)), if (c.keepsWorkspaceAwake) CC.keepsAwake else null)
    }

    /** One history line of a condition: "Fired · 90.4% for 10 min", "Ready again · 82.9%"; [runId] is the run a FIRED started,
     * which the line opens. */
    data class HistoryLine(val text: String, val chip: String, val runId: String?)

    fun historyLine(e: ConditionEventView, condition: ConditionView): HistoryLine? {
        val reading = e.value?.let { readingText(it, condition.unit) } ?: ""
        return when (e.kind) {
            "FIRED" -> {
                val hold = if (condition.holdSeconds > 0) fill(C.holdFor, mapOf("duration" to durationText(condition.holdSeconds))) else ""
                val text = if (e.repeat) fill(C.historyFiredAgain, mapOf("reading" to reading))
                    else fill(C.historyFired, mapOf("reading" to reading, "hold" to hold))
                HistoryLine(text, if (e.runId != null) C.chipRun else C.chipCondition, e.runId)
            }
            "READY_AGAIN" -> HistoryLine(fill(C.historyReadyAgain, mapOf("reading" to reading)), C.chipCondition, null)
            "CANT_READ" -> HistoryLine(C.historyCantRead, C.chipCondition, null)
            "READ_AGAIN" -> HistoryLine(fill(C.historyReadAgain, mapOf("reading" to reading)), C.chipCondition, null)
            "ASKED_STILL_WAITING" -> HistoryLine(C.historyAsked, C.chipCondition, null)
            else -> null
        }
    }

    // A run's session (board ⑤ ②)

    /** "Fired 03:12 · 90.4% for 10 min · Check only": what fired the run, in place of when it was planned. The value is the FIRED
     * event's that started this run; without the condition's read, the time alone. */
    fun runFiredText(run: ScheduleRunView, condition: ConditionView?, accessLevel: String, timezone: String): String {
        val key = scheduleIdKey(run.id)
        val event = condition?.events?.firstOrNull { it.kind == "FIRED" && it.runId?.let(::scheduleIdKey) == key }
        val at = ScheduleDisplay.parse(event?.at ?: run.plannedAt)?.let { ScheduleDisplay.localParts(it, timezone).time } ?: ""
        val parts = mutableListOf(fill(if (event?.repeat == true) C.runFiredAgain else C.runFired, mapOf("time" to at)))
        val value = event?.value
        if (condition != null && value != null) {
            val reading = readingText(value, condition.unit)
            parts += if (condition.holdSeconds > 0 && !event.repeat)
                fill(CC.held, mapOf("condition" to reading, "duration" to durationText(condition.holdSeconds))) else reading
        }
        parts += ScheduleDisplay.accessCopy(accessLevel).label
        return parts.joinToString(ScheduleCopy.separator)
    }

    // Waiting on you (board ⑥ ①)

    /** The buttons a condition's card carries: Pause and Look into it on a can't-read card of a schedule, Look into it on a task's;
     * the 30-day question's own two answers. */
    fun waitingActions(item: ConditionWaitingItem, scheduleId: String?): List<String> {
        if (item.isStillWaiting) return item.options.map { it.label }.ifEmpty { listOf(C.keepWaiting, C.stop) }
        return if (scheduleId != null) listOf(C.pause, C.lookIntoIt) else listOf(C.lookIntoIt)
    }
}
