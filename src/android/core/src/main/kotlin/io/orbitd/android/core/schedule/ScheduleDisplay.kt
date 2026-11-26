package io.orbitd.android.core.schedule

import io.orbitd.android.core.schedule.ScheduleCopy as C
import java.time.Duration
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.ZoneOffset
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * The rules that turn the schedule doors' shapes into what the client draws: the timeline's groups, a row's circle, a
 * rule in words, the Costs line, an envelope card's Now / Asked, who made a change, and the Waiting on you cards. A
 * port of OrbitKit's App/ScheduleDisplay.swift, function for function, which mirrors `src/shared/src/schedule.ts`
 * (the web's rules); the contract's `boardPhrases` hold all three to the boards' words (ScheduleCopyParityTest).
 */
object ScheduleDisplay {
    val weekdayOrder: List<String> = listOf("MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN")

    /** Fill `{name}` placeholders; a placeholder with no value is left as it is, so a missing value shows. */
    fun fill(template: String, values: Map<String, String>): String {
        val out = StringBuilder()
        var rest = template
        while (true) {
            val open = rest.indexOf('{')
            if (open < 0) break
            out.append(rest, 0, open)
            val close = rest.indexOf('}', open + 1)
            if (close < 0) {
                out.append(rest, open, rest.length)
                return out.toString()
            }
            val key = rest.substring(open + 1, close)
            val isWord = key.isNotEmpty() && key.all { it.isLetterOrDigit() || it == '_' }
            val value = if (isWord) values[key] else null
            if (value != null) out.append(value) else out.append(rest, open, close + 1)
            rest = rest.substring(close + 1)
        }
        out.append(rest)
        return out.toString()
    }

    internal fun capitalize(text: String): String = if (text.isEmpty()) text else text[0].uppercase() + text.substring(1)
    internal fun lowerFirst(text: String): String = if (text.isEmpty()) text else text[0].lowercase() + text.substring(1)

    // Time, in the viewer's zone

    /** One instant read on a zone's calendar. [dayNumber] is days since 1970-01-01 of the local date. */
    data class LocalParts(val dayNumber: Int, val month: Int, val day: Int, val weekday: String, val time: String)

    /** An ISO instant ("2025-11-14T04:19:00.000Z", or with an offset); null when it is not one. */
    fun parse(iso: String): Instant? = runCatching { Instant.parse(iso) }.getOrNull()
        ?: runCatching { OffsetDateTime.parse(iso).toInstant() }.getOrNull()

    private fun zone(timezone: String): ZoneId = runCatching { ZoneId.of(timezone) }.getOrDefault(ZoneOffset.UTC)

    fun localParts(at: Instant, timezone: String): LocalParts {
        val local = at.atZone(zone(timezone))
        return LocalParts(local.toLocalDate().toEpochDay().toInt(), local.monthValue, local.dayOfMonth,
            weekdayOrder[local.dayOfWeek.value - 1], String.format(java.util.Locale.ROOT, "%02d:%02d", local.hour, local.minute))
    }

    /** "Nov 14". */
    fun dateText(at: Instant, timezone: String): String {
        val p = localParts(at, timezone)
        return fill(C.Dates.day, mapOf("month" to C.months[p.month - 1], "day" to p.day.toString()))
    }

    /** "Fri, Nov 14". */
    fun dayWithWeekdayText(at: Instant, timezone: String): String {
        val p = localParts(at, timezone)
        return fill(C.Dates.dayWithWeekday, mapOf("weekday" to (C.weekdaysShort[p.weekday] ?: p.weekday),
            "month" to C.months[p.month - 1], "day" to p.day.toString()))
    }

    /** "Today", "Tomorrow", "Monday" within the coming week, else "Nov 24". */
    fun dayText(at: Instant, now: Instant, timezone: String): String {
        val p = localParts(at, timezone)
        val offset = p.dayNumber - localParts(now, timezone).dayNumber
        if (offset == 0) return C.Dates.today
        if (offset == 1) return C.Dates.tomorrow
        if (offset in 2..6) return C.weekdays[p.weekday] ?: p.weekday
        return fill(C.Dates.day, mapOf("month" to C.months[p.month - 1], "day" to p.day.toString()))
    }

    /** "Today 02:00", "Tomorrow 09:00", "Monday 09:00", "Nov 24 09:00". */
    fun whenText(at: Instant, now: Instant, timezone: String): String =
        fill(C.Dates.at, mapOf("day" to dayText(at, now, timezone), "time" to localParts(at, timezone).time))

    /** A slot that has passed, inside a sentence: "Monday 09:00" within the last week, else "Nov 10, 09:00". */
    fun pastWhenText(at: Instant, now: Instant, timezone: String): String {
        val p = localParts(at, timezone)
        val back = localParts(now, timezone).dayNumber - p.dayNumber
        if (back in 0..6) return fill(C.Dates.at, mapOf("day" to (C.weekdays[p.weekday] ?: p.weekday), "time" to p.time))
        return "${dateText(at, timezone)}, ${p.time}"
    }

    /** "First run tomorrow" / "First run Monday". */
    fun firstRunText(at: Instant, now: Instant, timezone: String, inline: Boolean = false): String {
        val day = dayText(at, now, timezone)
        val lowered = when (day) { C.Dates.today -> C.Dates.todayLower; C.Dates.tomorrow -> C.Dates.tomorrowLower; else -> day }
        return fill(if (inline) C.CreateCard.firstRunInline else C.CreateCard.firstRun, mapOf("day" to lowered))
    }

    // Rules and costs

    enum class RuleForm { short, long }

    /** "Daily 10:00", "Mondays 10:00", "Weekdays at 09:00", "Mon, Thu 10:00", "Once" (short);
     * "Every day at 02:00", "Every Monday at 09:00", "Weekdays at 09:00", "Every Mon, Thu at 10:00" (long). */
    fun ruleText(rule: ScheduleRule, form: RuleForm = RuleForm.short): String {
        val short = form == RuleForm.short
        val daily = if (short) C.Rules.shortDaily else C.Rules.longDaily
        return when (rule) {
            // "Raw used above 90%" (short), "When raw used above 90%" (long): shared SCHEDULE_CONDITION_COPY.rules.
            is ScheduleRule.When -> if (short) fill(ScheduleConditionCopy.rulesShort, mapOf("condition" to rule.condition.text))
                else fill(ScheduleConditionCopy.rulesLong, mapOf("condition" to lowerFirst(rule.condition.text)))
            is ScheduleRule.Once -> if (short) C.Rules.shortOnce else C.Rules.longOnce
            is ScheduleRule.Daily -> fill(daily, mapOf("time" to rule.time))
            is ScheduleRule.Every -> everyRuleText(rule)
            is ScheduleRule.Weekly -> {
                val time = rule.time
                val days = weekdayOrder.filter { it in rule.weekdays }
                when {
                    days.size == 7 -> fill(daily, mapOf("time" to time))
                    days.size == 5 && days.containsAll(listOf("MON", "TUE", "WED", "THU", "FRI")) ->
                        fill(if (short) C.Rules.shortWeekdays else C.Rules.longWeekdays, mapOf("time" to time))
                    days.size == 1 -> days[0].let { d ->
                        if (short) fill(C.Rules.shortWeekday, mapOf("weekdays" to (C.weekdaysPlural[d] ?: d), "time" to time))
                        else fill(C.Rules.longWeekday, mapOf("weekday" to (C.weekdays[d] ?: d), "time" to time))
                    }
                    else -> fill(if (short) C.Rules.shortDays else C.Rules.longDays,
                        mapOf("days" to days.joinToString(C.Rules.daysSeparator) { C.weekdaysShort[it] ?: it }, "time" to time))
                }
            }
        }
    }

    /** An EVERY rule's sentence, the same in both forms: "Every 30 min, 09:00–18:00, Mon–Fri", "Every hour". */
    internal fun everyRuleText(rule: ScheduleRule.Every): String {
        val e = C.Every
        val interval = when {
            rule.minutes < 60 -> fill(e.minutes, mapOf("count" to rule.minutes.toString()))
            rule.minutes == 60 -> e.hour
            else -> fill(e.hours, mapOf("count" to (rule.minutes / 60).toString()))
        }
        val text = when {
            rule.until != null -> fill(e.window, mapOf("interval" to interval, "time" to rule.time, "until" to rule.until))
            rule.time == "00:00" -> interval
            else -> fill(e.from, mapOf("interval" to interval, "time" to rule.time))
        }
        val days = weekdayOrder.filter { it in rule.weekdays }
        if (days.size == 7) return text
        val named = when {
            days.size == 5 && days.containsAll(listOf("MON", "TUE", "WED", "THU", "FRI")) -> e.workweek
            days.size == 2 && days.containsAll(listOf("SAT", "SUN")) -> e.weekend
            else -> days.joinToString(C.Rules.daysSeparator) { C.weekdaysShort[it] ?: it }
        }
        return fill(e.days, mapOf("rule" to text, "days" to named))
    }

    /** A schedule's planned end as one line: "until 18:00 today", "until Nov 25", "3 runs left", or both; null without an end. */
    fun endText(schedule: ScheduleView, now: Instant, timezone: String): String? {
        val e = C.End
        val parts = mutableListOf<String>()
        schedule.endAt?.let(::parse)?.let { at ->
            val time = localParts(at, timezone).time
            val day = dayText(at, now, timezone)
            val whenText = when (day) {
                C.Dates.today -> fill(e.today, mapOf("time" to time))
                C.Dates.tomorrow -> fill(e.tomorrow, mapOf("time" to time))
                else -> dateText(at, timezone)
            }
            parts += fill(e.until, mapOf("when" to whenText))
        }
        schedule.maxRuns?.let {
            val left = schedule.runsLeft ?: it
            parts += if (left == 1) e.runLeft else fill(e.runsLeft, mapOf("count" to left.toString()))
        }
        return parts.takeIf { it.isNotEmpty() }?.joinToString(C.separator)
    }

    /** "16 slots missed, 01:00–08:30": consecutive MISSED runs of one schedule as one line. */
    fun missedText(runs: List<ScheduleRunView>, timezone: String): String {
        val times = runs.mapNotNull { parse(it.plannedAt) }.sorted()
        val first = times.firstOrNull() ?: return fill(C.End.missed, mapOf("count" to runs.size.toString(), "from" to "", "to" to ""))
        val last = times.last()
        val a = localParts(first, timezone)
        val b = localParts(last, timezone)
        if (a.month == b.month && a.day == b.day) {
            return fill(C.End.missed, mapOf("count" to runs.size.toString(), "from" to a.time, "to" to b.time))
        }
        return fill(C.End.missedDated, mapOf("count" to runs.size.toString(), "fromDate" to dateText(first, timezone), "from" to a.time,
            "toDate" to dateText(last, timezone), "to" to b.time))
    }

    /** Whether a row shows the repeat mark before its rule: a one-off does not. */
    fun ruleRepeats(rule: ScheduleRule): Boolean = rule !is ScheduleRule.Once

    /** "7 runs a week", "1 run a week". */
    fun runsPerWeekText(runsPerWeek: Int): String =
        fill(if (runsPerWeek == 1) C.Costs.runsOne else C.Costs.runsOther, mapOf("count" to runsPerWeek.toString()))

    /** The Costs line, "Up to 7 runs a week, 30 min each", with the part the card sets in bold. */
    data class CostsParts(val text: String, val before: String, val emphasis: String, val after: String)

    fun costsParts(runsPerWeek: Int, runLimitMinutes: Int): CostsParts {
        val emphasis = runsPerWeekText(runsPerWeek)
        val text = fill(C.Costs.upTo, mapOf("runs" to emphasis, "minutes" to runLimitMinutes.toString()))
        val at = text.indexOf(emphasis)
        if (at < 0) return CostsParts(text, text, "", "")
        return CostsParts(text, text.substring(0, at), emphasis, text.substring(at + emphasis.length))
    }

    fun costsText(runsPerWeek: Int, runLimitMinutes: Int): String = costsParts(runsPerWeek, runLimitMinutes).text

    /** "Allowed: up to 7 runs a week, 30 min each", under This month. */
    fun allowedText(runsPerWeek: Int, runLimitMinutes: Int): String = fill(C.Costs.allowed, mapOf("costs" to
        fill(C.Costs.upToLower, mapOf("runs" to runsPerWeekText(runsPerWeek), "minutes" to runLimitMinutes.toString()))))

    /** "14 runs · 41 min". */
    fun usageText(runs: Int, minutes: Int): String =
        fill(if (runs == 1) C.Inspector.usageOne else C.Inspector.usageOther, mapOf("runs" to runs.toString(), "minutes" to minutes.toString()))

    fun accessCopy(level: String): ScheduleAccessCopy = C.access[level] ?: ScheduleAccessCopy(level, "", "")

    /** "Check only · reads and reports, edits nothing": the create card's May line. */
    fun mayText(level: String): String = accessCopy(level).let { "${it.label}${C.separator}${it.detail}" }

    /** "Claude", "Codex": an engine id as the card names it. */
    fun engineName(engine: String): String = capitalize(engine)

    /** "apiserver · Codex agent". */
    fun runsInText(workspaceName: String, engine: String?): String {
        if (engine.isNullOrEmpty()) return workspaceName
        return fill(C.CreateCard.runsInEngine, mapOf("workspace" to workspaceName, "engine" to engineName(engine)))
    }

    /** The create card's last line (S5 `scheduleCreateNotice`); with no word for what the task finds, the plain notice. */
    fun createNotice(findings: String?): String {
        val what = findings?.trim().orEmpty()
        return if (what.isEmpty()) C.CreateCard.notice else fill(C.CreateCard.noticeAbout, mapOf("findings" to what))
    }

    /** The create card's When: "Daily 10:00 · Asia/Shanghai · first run tomorrow", with its parts. */
    data class CreateWhen(val text: String, val rule: String, val zone: String, val firstRun: String?)

    fun createWhen(`when`: ScheduleCardWhen, now: Instant, viewerTimezone: String): CreateWhen {
        if (`when`.rule is ScheduleRule.When) {
            // A WHEN rule has no time, so no zone and no first run: its lines are `when.condition`.
            val rule = `when`.condition?.text ?: ruleText(`when`.rule, RuleForm.short)
            return CreateWhen(rule, rule, "", null)
        }
        val zone = `when`.timezone ?: C.CreateCard.zoneFromDevice
        val rule = ruleText(`when`.rule, RuleForm.short)
        val at = `when`.firstRunAt?.let(::parse)
        val tz = `when`.timezone ?: viewerTimezone
        val firstRun = at?.let { firstRunText(it, now, tz) }
        val inline = at?.let { firstRunText(it, now, tz, inline = true) }
        return CreateWhen(listOfNotNull(rule, zone, inline).joinToString(C.separator), rule, zone, firstRun)
    }

    // Circles

    /** A row's circle (board 1/2 ①): `open` is to come, `running` turns, `done` a grey tick, `new` a green tick,
     * `failed` red, `held` amber, `draft` dashed, `paused` faint, `muted` a run that never did the work. */
    enum class Circle { open, running, done, new, failed, held, draft, paused, muted;
        val rawValue: String get() = name
    }
    enum class Mark { check, alert, clock }
    enum class TagTone { new, fail, held, mute }

    data class Tag(val tone: TagTone, val text: String)
    /** [gauge]: a condition's row (condition-triggers board ④ ③), a gauge in place of the circle, in the circle's tone. */
    data class CircleView(val circle: Circle, val mark: Mark? = null, val tag: Tag? = null, val gauge: Boolean = false)

    /** A run's circle. A CHANGED run is `new` when its finding was new, else a grey tick tagged Known. */
    fun runCircle(state: String, newFinding: Boolean = false): CircleView {
        val label = C.runStates[state] ?: state
        return when (state) {
            "QUEUED" -> CircleView(Circle.open, Mark.clock)
            "RUNNING" -> CircleView(Circle.running)
            "AWAITING_APPROVAL" -> CircleView(Circle.held, Mark.alert, Tag(TagTone.held, label))
            "NO_CHANGE" -> CircleView(Circle.done, Mark.check, Tag(TagTone.mute, label))
            "CHANGED" -> if (newFinding) CircleView(Circle.new, Mark.check, Tag(TagTone.new, C.Tags.new))
                else CircleView(Circle.done, Mark.check, Tag(TagTone.mute, C.Tags.known))
            "FAILED" -> CircleView(Circle.failed, Mark.alert, Tag(TagTone.fail, C.Tags.failed))
            "HELD" -> CircleView(Circle.held, Mark.alert, Tag(TagTone.held, C.Tags.held))
            else -> CircleView(Circle.muted, Mark.check, Tag(TagTone.mute, label))
        }
    }

    /** A schedule's circle on its next occurrence, or in Paused. A failing one whose next run is under way: [rowCircle]. */
    fun scheduleCircle(state: String, consecutiveFailures: Int, draft: Boolean = false): CircleView {
        if (draft) return CircleView(Circle.draft)
        return when (state) {
            "PAUSED" -> CircleView(Circle.paused)
            "HELD" -> CircleView(Circle.held, Mark.alert, Tag(TagTone.held, C.Tags.held))
            "ENDED" -> CircleView(Circle.muted)
            else -> if (consecutiveFailures > 0) {
                val text = if (consecutiveFailures > 1) fill(C.Tags.failedInARow, mapOf("count" to consecutiveFailures.toString()))
                    else C.Tags.failed
                CircleView(Circle.failed, Mark.alert, Tag(TagTone.fail, text))
            } else CircleView(Circle.open)
        }
    }

    fun scheduleCircle(schedule: ScheduleView, draft: Boolean = false): CircleView {
        if (schedule.state == "ACTIVE" && schedule.consecutiveFailures == 0 && schedule.condition?.cantRead == true) {
            return ConditionDisplay.circle(cantRead = true)
        }
        val view = scheduleCircle(schedule.state, schedule.consecutiveFailures, draft)
        // A WHEN schedule keeps its gauge in every group (condition-triggers board ④ ③).
        return if (schedule.rule is ScheduleRule.When) view.copy(gauge = true) else view
    }

    /** Whether one of [runs] (the list's timeline runs) is a run of [schedule] under way: queued, running or waiting for an approval. */
    fun runUnderWay(schedule: ScheduleView, runs: List<ScheduleRunView>): Boolean =
        runs.any { it.scheduleId == schedule.id && it.state in inProgress }

    /** Failing or held, by state alone (§9.2). Whether a run is under way needs the schedule: [needsYou] with its runs. */
    fun needsYou(state: String, consecutiveFailures: Int): Boolean = state == "HELD" || (state == "ACTIVE" && consecutiveFailures > 0)

    /**
     * Needs you: held, failing with no run of it under way (§9.2), or a WHEN rule whose condition cannot be read
     * (condition-triggers §9) — the count beside Scheduled in the drawer. A failing schedule whose next run is already under way
     * (Run now, owner 2026-11-19) waits for that run: a failure keeps consecutiveFailures above zero and puts it back, a run that
     * did not fail has the server reset it.
     */
    fun needsYou(schedule: ScheduleView, runs: List<ScheduleRunView> = emptyList()): Boolean {
        if (schedule.state == "HELD") return true
        if (schedule.state != "ACTIVE") return false
        return schedule.condition?.cantRead == true || (schedule.consecutiveFailures > 0 && !runUnderWay(schedule, runs))
    }

    /** The drawer's number: how many schedules, and tasks waiting on a condition, need you; nothing at zero. */
    fun needsYouCount(schedules: List<ScheduleView>, waitingTasks: List<ScheduleWaitingTask> = emptyList(),
                      runs: List<ScheduleRunView> = emptyList()): Int =
        schedules.count { needsYou(it, runs) } + waitingTasks.count { it.condition.cantRead }

    /** A schedule's row circle on the page: its Failed tag stays off while a run of it is under way (owner 2026-11-19). */
    fun rowCircle(schedule: ScheduleView, runs: List<ScheduleRunView>): CircleView =
        if (schedule.state == "ACTIVE" && schedule.consecutiveFailures > 0 && runUnderWay(schedule, runs)) {
            scheduleCircle(schedule.copy(consecutiveFailures = 0))
        } else scheduleCircle(schedule)

    // A row's second line

    /** Why a run failed, as a clause: the server's reasonText (S2d) when it has one. */
    fun failureClause(failureReason: String?, reasonText: String?): String? {
        if (!reasonText.isNullOrEmpty()) return reasonText
        return failureReason?.let { C.failureReasons[it] }
    }

    /** Why a schedule is held, as a clause: 'the agent "auditor" is disabled'. */
    fun heldClause(reason: String?, agent: String? = null, workspace: String? = null): ScheduleHeldCopy? {
        val entry = reason?.let { C.heldReasons[it] } ?: return null
        val values = buildMap {
            if (!agent.isNullOrEmpty()) put("agent", agent)
            if (!workspace.isNullOrEmpty()) put("workspace", workspace)
        }
        val clause = fill(entry.clause, values)
            .replaceFirst("the agent \"{agent}\"", "its agent")
            .replaceFirst("the workspace {workspace}", "its workspace")
        return ScheduleHeldCopy(clause, entry.until)
    }

    /** A schedule row's second line: "Every day at 02:00 · apiserver · Check only". A held schedule says why in place of
     * the access, a paused one when it paused; a running one adds how long, a draft that it waits. */
    fun rowLine(rule: ScheduleRule, workspaceName: String?, accessLevel: String, state: String, heldReason: String?,
                agentName: String? = null, pausedAt: Instant? = null, timezone: String? = null, runningMinutes: Int? = null,
                draft: Boolean = false): String {
        val parts = mutableListOf(ruleText(rule, RuleForm.long))
        if (!workspaceName.isNullOrEmpty()) parts += workspaceName
        if (state == "HELD") parts += heldClause(heldReason, agentName)?.clause ?: accessCopy(accessLevel).label
        else if (state == "PAUSED" && pausedAt != null && timezone != null) parts += fill(C.Row.pausedOn, mapOf("date" to dateText(pausedAt, timezone)))
        else parts += accessCopy(accessLevel).label
        if (runningMinutes != null) parts += fill(C.Row.runningFor, mapOf("minutes" to runningMinutes.toString()))
        if (draft) parts += C.Row.draft
        return parts.joinToString(C.separator)
    }

    /** A schedule row's second line on a phone (iOS board 01 ②), one line — the shared `schedulePhoneRowLine`. */
    fun phoneRowLine(rule: ScheduleRule, workspaceName: String?, accessLevel: String, state: String, heldReason: String?,
                     pausedAt: Instant? = null, timezone: String? = null, runningMinutes: Int? = null, draft: Boolean = false): String {
        val parts = mutableListOf(ruleText(rule, RuleForm.short))
        if (state == "HELD") {
            parts += heldReason?.let { C.heldShort[it] } ?: C.Tags.held
        } else {
            if (!workspaceName.isNullOrEmpty()) parts += workspaceName
            if (accessLevel != "CHECK_ONLY") parts += accessCopy(accessLevel).label
            if (state == "PAUSED" && pausedAt != null && timezone != null) parts += fill(C.Row.pausedOn, mapOf("date" to dateText(pausedAt, timezone)))
        }
        if (runningMinutes != null) parts += fill(C.Row.runningShort, mapOf("minutes" to runningMinutes.toString()))
        if (draft) parts += C.Row.draftShort
        return parts.joinToString(C.separator)
    }

    /** A past run's second line: "Ended without a report", "2.1.310 is out · you were notified". */
    fun runLine(state: String, summary: String?, failureReason: String?, reasonText: String?, notified: Boolean = false): String {
        if (state == "FAILED" || state == "MISSED" || state == "HELD") {
            // A reported failure says what the run reported, as its Waiting card and push do (W3).
            val clause = reportedFailureClause(failureReason, reasonText, summary) ?: failureClause(failureReason, reasonText)
            return clause?.let(::capitalize) ?: C.runStates[state] ?: state
        }
        val parts = mutableListOf(summary ?: C.runStates[state] ?: state)
        if (state == "CHANGED" || state == "NO_CHANGE") parts += if (notified) C.Row.notified else C.Row.notNotified
        return parts.joinToString(C.separator)
    }

    // The timeline

    enum class GroupKey(val rawValue: String) { condition("CONDITION"), today("TODAY"), tomorrow("TOMORROW"),
        day("DAY"), later("LATER"), paused("PAUSED") }

    sealed class TimelineItem {
        abstract val at: String?
        abstract val id: String

        data class Schedule(val schedule: ScheduleView, override val at: String?) : TimelineItem() {
            override val id: String get() = "schedule-${schedule.id}"
        }
        data class Run(val schedule: ScheduleView, val run: ScheduleRunView, override val at: String) : TimelineItem() {
            override val id: String get() = "run-${run.id}"
        }
        /** Two or more consecutive MISSED runs of one schedule, as one line ([missedText]); [at] is the last one's slot. */
        data class Missed(val schedule: ScheduleView, val runs: List<ScheduleRunView>, override val at: String) : TimelineItem() {
            override val id: String get() = "missed-${runs.first().id}"
        }
        data class Draft(val card: ScheduleCard, override val at: String) : TimelineItem() {
            override val id: String get() = "draft-${card.id}"
        }
        /** A task that starts when its condition holds (condition-triggers board ④ ①). */
        data class Task(val task: ScheduleWaitingTask) : TimelineItem() {
            override val at: String? get() = null
            override val id: String get() = "task-${task.id}"
        }
    }

    data class TimelineGroup(
        val key: GroupKey,
        /** "Waiting for a condition", "Today", "Monday", "Later", "Paused". */
        val title: String,
        /** "Fri, Nov 14" under Today and Tomorrow, "Nov 17" under a day, the count under Waiting for a condition and Paused. */
        val subtitle: String?,
        val items: List<TimelineItem>,
    ) {
        val id: String get() = if (key == GroupKey.day) "day-$title" else key.rawValue
    }

    internal val inProgress = setOf("QUEUED", "RUNNING", "AWAITING_APPROVAL")

    /**
     * The Scheduled page's groups (§9.2), in the viewer's zone: Waiting for a condition (the WHEN schedules and the tasks waiting on
     * their startWhen, the ones that cannot be read first: a condition has no day, so it is a group of its own above Today,
     * condition-triggers §9), Today, Tomorrow, each day of the coming week by its name, Later, Paused (held before paused: a held
     * schedule has no next run to be placed on). A schedule appears on the day of its next run, a draft on the day of its first; a
     * run under way on its planned day, an ended one on today's only with [showPastRuns]. Ended schedules appear nowhere; empty
     * groups are left out; a day is in time order.
     *
     * There is no Needs you group (owner 2026-11-19): the page lists the schedules, and a failing one is tagged on its own row on
     * the day of its next run ([rowCircle]); a failing WHEN schedule stays in Waiting for a condition.
     */
    fun timeline(schedules: List<ScheduleView>, runs: List<ScheduleRunView> = emptyList(), drafts: List<ScheduleCard> = emptyList(),
                 showPastRuns: Boolean = false, now: Instant, timezone: String,
                 waitingTasks: List<ScheduleWaitingTask> = emptyList()): List<TimelineGroup> {
        val today = localParts(now, timezone).dayNumber
        val byId = schedules.associateBy { it.id }
        val days = mutableMapOf<Int, MutableList<Pair<Int, TimelineItem>>>()
        val later = mutableListOf<Pair<Int, TimelineItem>>()
        var order = 0
        fun place(item: TimelineItem, at: String) {
            val date = parse(at) ?: return
            val day = maxOf(localParts(date, timezone).dayNumber, today)
            order += 1
            if (day - today >= 7) later += order to item else days.getOrPut(day) { mutableListOf() } += order to item
        }
        val byTitle = Comparator<ScheduleView> { a, b -> String.CASE_INSENSITIVE_ORDER.compare(a.title, b.title) }
        val byTaskTitle = Comparator<ScheduleWaitingTask> { a, b -> String.CASE_INSENSITIVE_ORDER.compare(a.title, b.title) }
        val (whenCantRead, whenReadable) = schedules.filter { it.rule is ScheduleRule.When && it.state == "ACTIVE" }.sortedWith(byTitle)
            .partition { it.condition?.cantRead == true }
        val (tasksCantRead, tasksReadable) = waitingTasks.sortedWith(byTaskTitle).partition { it.condition.cantRead }
        // Can't read first: the rows that need the owner lead the group.
        val waiting = whenCantRead.map { TimelineItem.Schedule(it, null) } + tasksCantRead.map { TimelineItem.Task(it) } +
            whenReadable.map { TimelineItem.Schedule(it, null) } + tasksReadable.map { TimelineItem.Task(it) }
        val paused = schedules.filter { it.state == "PAUSED" || it.state == "HELD" }
            .sortedWith(compareBy<ScheduleView> { if (it.state == "HELD") 0 else 1 }.then(byTitle))

        for (s in schedules) if (s.state == "ACTIVE") s.nextDueAt?.let { place(TimelineItem.Schedule(s, it), it) }
        for (card in drafts) card.`when`?.firstRunAt?.let { place(TimelineItem.Draft(card, it), it) }
        // A streak of MISSED runs of one schedule (two or more, with no other run of it between) shows as one item at its last slot.
        val streakOf = mutableMapOf<String, List<ScheduleRunView>>()
        if (showPastRuns) {
            for (list in runs.groupBy { it.scheduleId }.values) {
                var streak = mutableListOf<ScheduleRunView>()
                fun close() { if (streak.size > 1) streak.forEach { streakOf[it.id] = streak }; streak = mutableListOf() }
                for (run in list.sortedBy { parse(it.plannedAt) ?: Instant.EPOCH }) if (run.state == "MISSED") streak += run else close()
                close()
            }
        }
        val collapsed = mutableSetOf<List<ScheduleRunView>>()
        for (run in runs) {
            val schedule = byId[run.scheduleId] ?: continue
            if (run.state in inProgress) {
                place(TimelineItem.Run(schedule, run, run.plannedAt), run.plannedAt)
            } else if (showPastRuns) {
                val planned = parse(run.plannedAt)
                if (planned != null && localParts(planned, timezone).dayNumber == today) {
                    val streak = streakOf[run.id]
                    if (streak == null) place(TimelineItem.Run(schedule, run, run.plannedAt), run.plannedAt)
                    else if (collapsed.add(streak)) place(TimelineItem.Missed(schedule, streak, streak.last().plannedAt), streak.last().plannedAt)
                }
            }
        }

        val byTime = compareBy<Pair<Int, TimelineItem>> { it.second.at?.let(::parse)?.toEpochMilli() ?: 0L }.thenBy { it.first }
        val groups = mutableListOf<TimelineGroup>()
        if (waiting.isNotEmpty()) groups += TimelineGroup(GroupKey.condition, ConditionCopy.group, waiting.size.toString(), waiting)
        for (day in days.keys.sorted()) {
            val items = days.getValue(day).sortedWith(byTime).map { it.second }
            val at = items.firstOrNull()?.at?.let(::parse) ?: continue
            val offset = day - today
            val p = localParts(at, timezone)
            groups += if (offset == 0 || offset == 1) {
                TimelineGroup(if (offset == 0) GroupKey.today else GroupKey.tomorrow,
                    if (offset == 0) C.groups.getValue("TODAY") else C.groups.getValue("TOMORROW"), dayWithWeekdayText(at, timezone), items)
            } else {
                TimelineGroup(GroupKey.day, C.weekdays[p.weekday] ?: p.weekday, dateText(at, timezone), items)
            }
        }
        if (later.isNotEmpty()) groups += TimelineGroup(GroupKey.later, C.groups.getValue("LATER"), null, later.sortedWith(byTime).map { it.second })
        if (paused.isNotEmpty()) {
            groups += TimelineGroup(GroupKey.paused, C.groups.getValue("PAUSED"), paused.size.toString(), paused.map { TimelineItem.Schedule(it, null) })
        }
        return groups
    }

    // The envelope card: Now / Asked

    internal val accessOrder = mapOf("CHECK_ONLY" to 0, "OPEN_PR" to 1, "LAND" to 2)

    /** The parts of [after] wider than [before], in the card's order (schedule-envelope.ts widenedParts). */
    fun widenedParts(before: ScheduleEnvelope, after: ScheduleEnvelope): List<String> = buildList {
        if (after.workspaceId != before.workspaceId) add("WORKSPACE")
        if ((accessOrder[after.accessLevel] ?: 0) > (accessOrder[before.accessLevel] ?: 0)) add("ACCESS_LEVEL")
        if (after.runsPerWeek > before.runsPerWeek) add("RUNS_PER_WEEK")
        if (after.runLimitMinutes > before.runLimitMinutes) add("RUN_LIMIT")
        if (after.commandHash != null && after.commandHash != before.commandHash) add("PROBE_COMMAND")
    }

    /** One side of an envelope card. [lead] is the part set in bold on Asked ("Daily 10:00", "Open a PR"). */
    data class EnvelopeSide(val lead: String, val detail: String, val text: String)
    data class EnvelopeSides(val now: EnvelopeSide?, val asked: EnvelopeSide)

    /** The part a card is about: access first, then where it runs, how often, how long. */
    internal fun headPart(widens: List<String>): String? = listOf("ACCESS_LEVEL", "WORKSPACE", "PROBE_COMMAND", "RUNS_PER_WEEK", "RUN_LIMIT").firstOrNull { it in widens }

    /** An envelope card's Now and Asked lines (board 2/2 ② ③). Now names the run limit only where it differs. */
    fun envelopeSides(widens: List<String>, now: ScheduleEnvelope?, asked: ScheduleEnvelope, ruleNow: ScheduleRule? = null,
                      ruleAsked: ScheduleRule? = null, workspaceNames: Map<String, String> = emptyMap()): EnvelopeSides {
        val part = headPart(widens)
        fun side(e: ScheduleEnvelope, rule: ScheduleRule?, isNow: Boolean): EnvelopeSide {
            if (part == "ACCESS_LEVEL") {
                val a = accessCopy(e.accessLevel)
                val detail = if (isNow) a.brief else a.detail
                return EnvelopeSide(a.label, detail, "${a.label}${C.EnvelopeCard.accessJoin}$detail")
            }
            if (part == "PROBE_COMMAND") {
                // The command verbatim on both sides: what was approved, and what Allow would approve (board ⑥).
                val command = rule?.condition?.command ?: ""
                return EnvelopeSide(command, "", command)
            }
            val sameLimit = now?.runLimitMinutes == asked.runLimitMinutes
            val costs = if (isNow && sameLimit) fill(C.Costs.runsOnly, mapOf("runs" to runsPerWeekText(e.runsPerWeek)))
                else fill(C.Costs.upToLower, mapOf("runs" to runsPerWeekText(e.runsPerWeek), "minutes" to e.runLimitMinutes.toString()))
            val lead = if (part == "WORKSPACE") workspaceNames[e.workspaceId] ?: e.workspaceId
                else rule?.let { ruleText(it, RuleForm.short) } ?: ""
            return EnvelopeSide(lead, costs, if (lead.isEmpty()) capitalize(costs) else "$lead${C.separator}$costs")
        }
        return EnvelopeSides(now?.let { side(it, ruleNow, true) }, side(asked, ruleAsked ?: ruleNow, false))
    }

    /** "Let Codex stable check open PRs?" */
    fun envelopeTitle(title: String, widens: List<String>, workspaceName: String? = null, accessLevel: String? = null): String {
        val part = headPart(widens) ?: "RUNS_PER_WEEK"
        val values = buildMap { put("title", title); workspaceName?.let { put("workspace", it) } }
        return fill(if (part == "ACCESS_LEVEL" && accessLevel == "LAND") C.EnvelopeCard.landTitle else C.EnvelopeCard.titles[part] ?: "", values)
    }

    /** The card's decline button: "Keep check only", "Keep weekly", else "Keep as it is". */
    fun keepLabel(widens: List<String>, now: ScheduleEnvelope?, workspaceName: String? = null): String {
        val part = headPart(widens)
        if (part == "ACCESS_LEVEL" && now?.accessLevel == "CHECK_ONLY") return C.keep.getValue("ACCESS_LEVEL")
        if (part == "RUNS_PER_WEEK" && now?.runsPerWeek == 1) return C.keep.getValue("RUNS_PER_WEEK")
        if (part == "RUN_LIMIT" && now != null) return fill(C.keep.getValue("RUN_LIMIT"), mapOf("minutes" to now.runLimitMinutes.toString()))
        if (part == "WORKSPACE" && workspaceName != null) return fill(C.keep.getValue("WORKSPACE"), mapOf("workspace" to workspaceName))
        if (part == "PROBE_COMMAND") return ScheduleConditionCopy.keep
        return C.keep.getValue("other")
    }

    /** The note under an envelope card. */
    fun envelopeNote(widens: List<String>): String =
        if ("PROBE_COMMAND" in widens) ScheduleConditionCopy.commandNote
        else if ("ACCESS_LEVEL" in widens) "${C.EnvelopeCard.appliesFromNextRun} ${C.EnvelopeCard.checkedEachRun}" else C.EnvelopeCard.appliesFromNextRun

    /** A widen card in Waiting on you: "<reason> Now: Check only. Asked: Open a PR · edits in its own worktree…". */
    fun widenWaitingText(reason: String, widens: List<String>, now: ScheduleEnvelope?, asked: ScheduleEnvelope,
                         ruleNow: ScheduleRule? = null, ruleAsked: ScheduleRule? = null,
                         workspaceNames: Map<String, String> = emptyMap()): String {
        val sides = envelopeSides(widens, now, asked, ruleNow, ruleAsked, workspaceNames)
        val access = headPart(widens) == "ACCESS_LEVEL"
        val nowText = sides.now?.let { if (access) it.lead else it.text } ?: ""
        val askedText = if (access) "${sides.asked.lead}${C.separator}${sides.asked.detail}" else sides.asked.text
        return fill(C.Waiting.widenBody, mapOf("reason" to reason, "now" to nowText, "asked" to askedText)).trim(' ', '\t')
    }

    /** The pieces an envelope card draws, from the card and the schedule it changes. */
    data class EnvelopeCardText(val title: String, val now: EnvelopeSide?, val asked: EnvelopeSide, val keep: String, val note: String)

    fun envelopeCard(card: ScheduleCard, scheduleTitle: String?, ruleNow: ScheduleRule?): EnvelopeCardText? {
        val envelope = card.envelope ?: return null
        val names = mutableMapOf<String, String>()
        for (lines in listOfNotNull(envelope.now, envelope.asked)) lines.runsIn.workspaceName?.let { names[lines.runsIn.workspaceId] = it }
        val ruleAsked = ScheduleRule.parse(card.proposed?.get("rule"))
        val sides = envelopeSides(envelope.widens, envelope.now?.envelope, envelope.asked.envelope, ruleNow, ruleAsked, names)
        val title = card.title ?: scheduleTitle ?: ""
        return EnvelopeCardText(envelopeTitle(title, envelope.widens, envelope.asked.runsIn.workspaceName, envelope.asked.may.accessLevel), sides.now, sides.asked,
            keepLabel(envelope.widens, envelope.now?.envelope, envelope.now?.runsIn?.workspaceName), envelopeNote(envelope.widens))
    }

    // History and the change line

    /** Who a history entry names ([who] the closed-set key, [text] its word). */
    data class HistoryWho(val who: String, val text: String)

    /** Who a history entry names: You, Session or Run — and You allowed for a change a session or a run asked for that
     * grew the envelope, which only the owner's Allow can apply (§4). */
    fun historyWho(changedBy: String, before: JsonObject?, after: JsonObject?): HistoryWho {
        if (changedBy != "USER") {
            val b = ScheduleEnvelope.parse(before?.get("envelope"))
            val a = ScheduleEnvelope.parse(after?.get("envelope"))
            if (b != null && a != null && widenedParts(b, a).isNotEmpty()) return HistoryWho("ALLOWED", C.History.who.getValue("ALLOWED"))
        }
        return HistoryWho(changedBy, C.History.who[changedBy] ?: changedBy)
    }

    /** OrbitKit's `JSONValue.asString`: a string, a number or a boolean as text; null for anything else. */
    internal fun asString(value: JsonElement?): String? =
        (value as? JsonPrimitive)?.takeIf { it !is JsonNull }?.content

    internal fun fieldValueText(field: String, value: JsonElement?, names: Map<String, String>): String {
        if (value == null || value is JsonNull) return if (field == "endAt") C.History.noEnd else ""
        val text = asString(value)
        return when (field) {
            "accessLevel" -> C.access[text ?: ""]?.label ?: text ?: ""
            "runLimitMinutes" -> fill(C.History.minutes, mapOf("minutes" to (text ?: "")))
            "workspaceId" -> names[text ?: ""] ?: text ?: ""
            else -> text ?: ""
        }
    }

    /** What a revision changed: [field] is the label the change line lowercases. */
    data class RecordParts(val field: String?, val text: String)

    internal fun ruleChangeText(before: ScheduleRule?, after: ScheduleRule): RecordParts {
        val bt = before?.time
        val at = after.time
        if (before != null && bt != null && at != null) {
            val sameShape = when {
                before is ScheduleRule.Daily && after is ScheduleRule.Daily -> true
                before is ScheduleRule.Weekly && after is ScheduleRule.Weekly -> before.weekdays == after.weekdays
                else -> false
            }
            val ruleLabel = C.History.fields.getValue("rule")
            if (sameShape && bt != at) return RecordParts(ruleLabel, fill(C.History.change, mapOf("field" to ruleLabel, "before" to bt, "after" to at)))
            if (bt == at) {
                // "Daily → Mondays 10:00": the time is said once, after the arrow.
                var was = ruleText(before, RuleForm.short).dropLast(bt.length).trimEnd(' ')
                if (was.endsWith(" at")) was = was.dropLast(3)
                return RecordParts(null, fill(C.History.ruleChange, mapOf("before" to was, "after" to ruleText(after, RuleForm.short))))
            }
        }
        return RecordParts(null, fill(C.History.ruleChange, mapOf("before" to (before?.let { ruleText(it, RuleForm.short) } ?: ""),
            "after" to ruleText(after, RuleForm.short))))
    }

    /** What a revision changed, as one line: "Time 10:00 → 09:00", "Access → Open a PR", "Prompt: …", "Daily → Mondays
     * 10:00", "Name: Codex check → Codex stable check", "Created · Check only · up to 7 runs a week", "Paused". */
    fun recordParts(revision: Int, before: JsonObject?, after: JsonObject, names: Map<String, String> = emptyMap()): RecordParts {
        if (revision == 1 || before == null) {
            val envelope = ScheduleEnvelope.parse(after["envelope"])
            val access = asString(after["accessLevel"]) ?: envelope?.accessLevel
            return RecordParts(null, fill(C.History.created, mapOf(
                "access" to (access?.let { accessCopy(it).label } ?: ""),
                "runs" to (envelope?.let { fill(C.Costs.runsOnly, mapOf("runs" to runsPerWeekText(it.runsPerWeek))) } ?: ""),
            )))
        }
        val state = asString(after["state"])
        if (state != null) {
            if (state == "PAUSED") return RecordParts(null, C.History.paused)
            if (state == "ENDED") {
                val reason = C.endedReasons[asString(after["endedReason"]) ?: ""] ?: ""
                return RecordParts(null, fill(C.History.ended, mapOf("reason" to reason)))
            }
            if (state == "ACTIVE") return RecordParts(null, C.History.resumed)
        }
        val fields = after.keys.filter { it != "envelope" && it != "endedReason" }.sorted()
        val key = fields.firstOrNull { it == "rule" } ?: fields.firstOrNull { it == "accessLevel" } ?: orderedFirst(fields)
            ?: return RecordParts(null, "")
        if (key == "rule") ScheduleRule.parse(after["rule"])?.let { return ruleChangeText(ScheduleRule.parse(before["rule"]), it) }
        val label = C.History.fields[key] ?: key
        val a = fieldValueText(key, after[key], names)
        return when (key) {
            "prompt", "intent" -> RecordParts(label, fill(C.History.changeText, mapOf("field" to label, "after" to a)))
            "title" -> RecordParts(label, fill(C.History.changeText, mapOf("field" to label, "after" to "${fieldValueText(key, before[key], names)} → $a")))
            "accessLevel" -> RecordParts(label, fill(C.History.changeTo, mapOf("field" to label, "after" to a)))
            else -> RecordParts(label, fill(C.History.change, mapOf("field" to label, "before" to fieldValueText(key, before[key], names), "after" to a)))
        }
    }

    /** The web takes the first key the change wrote; the field list's order (`history.fields`) stands in for it, as on
     * OrbitKit, so the two clients agree. */
    internal fun orderedFirst(fields: List<String>): String? =
        listOf("title", "prompt", "intent", "rule", "timezone", "endAt", "accessLevel", "runLimitMinutes", "workspaceId")
            .firstOrNull { it in fields } ?: fields.firstOrNull()

    /** A person's rename as the history says it (§8.4 *Rename*): "Renamed from “Codex check”". Null for any other record,
     * an agent's new title included (OrbitKit `renamedText`). */
    fun renamedText(record: ScheduleChangeRecord): String? {
        if (record.changedBy != "USER" || record.after.keys != setOf("title")) return null
        val before = record.before ?: return null
        return fill(C.History.renamed, mapOf("title" to (asString(before["title"]) ?: "")))
    }

    /** The title a rename field would save: trimmed, and null when that is empty or the name it opened with. */
    fun renameTitle(draft: String, from: String): String? = draft.trim().takeIf { it.isNotEmpty() && it != from.trim() }

    fun recordText(record: ScheduleChangeRecord, names: Map<String, String> = emptyMap()): String =
        recordParts(record.revision, record.before, record.after, names).text

    /** The change line in a session: "Changed Codex stable check: time 10:00 → 09:00", or for an end "Ended Release 2.0
     * freeze watch: goal reached · by this run". */
    fun changeLineText(title: String, revision: Int, changedBy: String, before: JsonObject?, after: JsonObject,
                       names: Map<String, String> = emptyMap()): String {
        if (asString(after["state"]) == "ENDED") {
            val reason = C.endedReasons[asString(after["endedReason"]) ?: ""] ?: ""
            val by = when (changedBy) { "RUN" -> C.Record.byThisRun; "USER" -> C.Record.byYou; else -> C.Record.byASession }
            return fill(C.Record.ended, mapOf("title" to title, "reason" to reason, "by" to by))
        }
        val parts = recordParts(revision, before, after, names)
        val change = if (parts.field != null && parts.text.startsWith(parts.field)) lowerFirst(parts.text) else parts.text
        return fill(C.Record.changed, mapOf("title" to title, "change" to change))
    }

    fun changeLineText(record: ScheduleChangeRecord, names: Map<String, String> = emptyMap()): String =
        changeLineText(record.title, record.revision, record.changedBy, record.before, record.after, names)

    /** The change line's parts for drawing: "Changed " + bold title + ": rest". */
    data class ChangeLineParts(val lead: String, val title: String, val rest: String)

    fun changeLineParts(record: ScheduleChangeRecord, names: Map<String, String> = emptyMap()): ChangeLineParts {
        val text = changeLineText(record, names)
        val at = if (record.title.isEmpty()) -1 else text.indexOf(record.title)
        if (at < 0) return ChangeLineParts(text, "", "")
        return ChangeLineParts(text.substring(0, at), record.title, text.substring(at + record.title.length))
    }

    // Waiting on you

    data class WaitingText(val title: String, val kind: String, val body: String, val actions: List<String>, val alwaysAllow: String? = null)

    internal const val summaryMax = 120

    /** The failure clause a failure card and its push say (S5 `failedWaitingClause`): a REPORTED_FAILED run's own summary,
     * one line of at most 120 characters with no closing full stop, else the reason's clause. */
    internal fun failedWaitingClause(failureReason: String?, reasonText: String?, summary: String?): String =
        reportedFailureClause(failureReason, reasonText, summary) ?: failureClause(failureReason, reasonText)
            ?: C.failureReasons.getValue("REPORTED_FAILED")

    /** A REPORTED_FAILED run's clause with its own summary (shared `reportedFailureClause`), or null when the run has none,
     * or the server wrote its own reasonText. */
    internal fun reportedFailureClause(failureReason: String?, reasonText: String?, summary: String?): String? {
        if (reasonText != null) return null
        val template = C.failureReasonsWithSummary[failureReason ?: ""] ?: return null
        // A closing full stop, Latin or ideographic (U+3002), is dropped.
        val flat = (summary ?: "").split(Regex("\\s+")).filter { it.isNotEmpty() }.joinToString(" ").trimEnd('.', '\u3002')
        if (flat.isEmpty()) return null
        val clipped = if (flat.length <= summaryMax) flat else flat.take(summaryMax - 1).trim(' ', '\t') + "…"
        return fill(template, mapOf("summary" to clipped))
    }

    data class PushText(val title: String, val body: String)

    /** A failure's push (S5 `scheduleFailedPush`): the card's title, and "The last run ended without a report. It keeps
     * running until you pause it." */
    fun failedPush(title: String, consecutiveFailures: Int, failureReason: String?, reasonText: String?, summary: String? = null,
                   plannedAt: String, timezone: String): PushText {
        val card = failedWaiting(title, consecutiveFailures, failureReason, reasonText, summary, plannedAt, timezone)
        return PushText(card.title, fill(C.Push.failedBody, mapOf("reason" to failedWaitingClause(failureReason, reasonText, summary))))
    }

    /** "Release 2.0 freeze watch ended itself". */
    fun goalReachedPushTitle(title: String): String = fill(C.Push.goalReachedTitle, mapOf("title" to title))

    /** A failed schedule's card: "Nightly pg spec sweep failed 3 runs in a row". */
    fun failedWaiting(title: String, consecutiveFailures: Int, failureReason: String?, reasonText: String?, summary: String? = null,
                      plannedAt: String, timezone: String): WaitingText {
        val at = parse(plannedAt) ?: Instant.EPOCH
        return WaitingText(
            title = if (consecutiveFailures > 1) fill(C.Waiting.failedTitleInARow, mapOf("title" to title, "count" to consecutiveFailures.toString()))
                else fill(C.Waiting.failedTitle, mapOf("title" to title)),
            kind = C.Waiting.kindsSchedule,
            body = fill(C.Waiting.failedBody, mapOf(
                "reason" to failedWaitingClause(failureReason, reasonText, summary),
                "when" to "${dateText(at, timezone)}, ${localParts(at, timezone).time}",
            )),
            actions = listOf(C.Actions.openRun, C.Actions.pauseSchedule))
    }

    /** A held schedule's card: "Weekly dependency audit is held". */
    fun heldWaiting(title: String, heldReason: String?, plannedAt: String, agentName: String? = null, workspaceName: String? = null,
                    now: Instant, timezone: String): WaitingText {
        val held = heldClause(heldReason, agentName, workspaceName)
        val agent = heldReason == "AGENT_DISABLED" || heldReason == "AGENT_MISSING"
        val whereText = if (agent && agentName != null && workspaceName != null) fill(C.heldWhere, mapOf("workspace" to workspaceName)) else ""
        var reason = held?.clause ?: ""
        if (whereText.isNotEmpty()) {
            listOf(" is disabled", " no longer exists").firstOrNull { reason.endsWith(it) }?.let { tail ->
                reason = reason.dropLast(tail.length) + whereText + tail
            }
        }
        return WaitingText(
            title = fill(C.Waiting.heldTitle, mapOf("title" to title)),
            kind = C.Waiting.kindsSchedule,
            body = fill(C.Waiting.heldBody, mapOf(
                "when" to pastWhenText(parse(plannedAt) ?: now, now, timezone),
                "reason" to reason,
                "until" to (held?.until ?: C.heldReasons.getValue("SESSION_REFUSED").until),
            )),
            actions = listOf(if (agent) C.Actions.openAgentSettings else C.Actions.openSchedule, C.Actions.resume))
    }

    /** A run's approval card: "Nightly pg spec sweep wants to run a command". */
    fun approvalWaiting(title: String, deadline: String, nextAt: String?, pattern: String, workspaceName: String, now: Instant,
                        timezone: String): WaitingText {
        val deadlineTime = parse(deadline)?.let { localParts(it, timezone).time } ?: ""
        val nextDay = nextAt?.let(::parse)?.let { dayText(it, now, timezone) } ?: ""
        val next = when (nextDay) { C.Dates.today -> C.Dates.todayLower; C.Dates.tomorrow -> C.Dates.tomorrowLower; else -> nextDay }
        return WaitingText(
            title = fill(C.Waiting.approvalTitle, mapOf("title" to title)),
            kind = C.Waiting.kindsRun,
            body = fill(C.Waiting.approvalBody, mapOf("deadline" to deadlineTime, "next" to next)),
            actions = listOf(C.Actions.alwaysAllow, C.Actions.allowOnce, C.Actions.deny),
            alwaysAllow = fill(C.Waiting.approvalAlwaysAllow, mapOf("pattern" to pattern, "workspace" to workspaceName)))
    }

    /** How long a run waits on an approval before it fails (§6.4): the approval card's deadline. */
    val approvalTimeout: Duration = Duration.ofHours(2)

    // A run's session

    /** "Scheduled run · planned 10:00, started 10:01 · access Check only". */
    fun runStripText(plannedAt: String, startedAt: String?, accessLevel: String, timezone: String): String =
        fill(C.RunSession.strip, mapOf(
            "planned" to (parse(plannedAt)?.let { localParts(it, timezone).time } ?: ""),
            "started" to (startedAt?.let(::parse)?.let { localParts(it, timezone).time } ?: "—"),
            "access" to accessCopy(accessLevel).label,
        ))

    /** "Run of Nov 13": the condition history's run label. */
    fun capitalizedRunOf(plannedAt: String, timezone: String): String = capitalize(runOfText(plannedAt, timezone))

    /** The delete question's title: "Delete “Codex stable check”?". */
    fun deleteTitle(title: String): String = fill(C.DeleteConfirm.title, mapOf("title" to title))

    /** "run of Nov 13". */
    fun runOfText(plannedAt: String, timezone: String): String =
        fill(C.RunSession.runOf, mapOf("date" to (parse(plannedAt)?.let { dateText(it, timezone) } ?: "")))

    /** A run that has ended, which is when its report is drawn. */
    fun runEnded(state: String): Boolean = state in setOf("NO_CHANGE", "CHANGED", "FAILED", "MISSED", "SKIPPED", "HELD", "CANCELLED")

    /** Whether a run's report is a failure's line rather than "Reported: …". */
    fun runReportFailed(state: String): Boolean = state != "NO_CHANGE" && state != "CHANGED"

    data class FindingFacts(val newFinding: Boolean, val notified: Boolean)

    /** Whether this run's finding was new, and whether the owner was told (the web's `runFindingFacts`): the list's own
     * answer when it carries one, else worked out from the schedule's findings. */
    fun runFindingFacts(run: ScheduleRunView, findings: List<ScheduleFindingView>): FindingFacts {
        run.newFinding?.let { return FindingFacts(it, run.notified ?: false) }
        val key = run.key ?: return FindingFacts(false, false)
        val first = findings.firstOrNull { it.key == key }?.firstRunId ?: return FindingFacts(false, false)
        val finding = findings.first { it.key == key }
        val isNew = scheduleIdKey(first) == scheduleIdKey(run.id)
        return FindingFacts(isNew, isNew && finding.notifiedAt != null)
    }

    /** The record's Undo still applies: it has a door, nothing undid it, and it is not itself an undo. */
    fun recordUndoable(record: ScheduleChangeRecord): Boolean =
        record.undo != null && record.undoneByRevision == null && record.undoOfRevision == null

    /** "Reported: Changed · codex@0.49.0 · you were notified". */
    fun reportedText(state: String, key: String?, notified: Boolean = false): String {
        val parts = mutableListOf(fill(C.RunSession.reported, mapOf("state" to (C.runStates[state] ?: state))))
        if (!key.isNullOrEmpty()) parts += key
        if (notified) parts += C.Row.notified
        return parts.joinToString(C.separator)
    }
}

/** OrbitKit `PublicID.storageKey`: either spelling of an id (UUID or base62 short id) in, one stable key out. */
internal fun scheduleIdKey(id: String): String = scheduleCanonicalId(id) ?: id

/** The UUID a public id spells, lowercase (the same reading as OwnerRequests' canonicalId). */
internal fun scheduleCanonicalId(value: String): String? {
    if (value.matches(Regex("[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"))) return value.lowercase()
    val alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
    if (value.isEmpty() || value.length > 22 || value.any { it !in alphabet }) return null
    var number = java.math.BigInteger.ZERO
    value.forEach { number = number * java.math.BigInteger.valueOf(62) + java.math.BigInteger.valueOf(alphabet.indexOf(it).toLong()) }
    if (number.bitLength() > 128) return null
    val hex = number.toString(16).padStart(32, '0')
    return "${hex.take(8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20)}"
}
