package io.orbitd.android.core.schedule

import kotlinx.serialization.json.*

// Scheduled tasks (docs/scheduled-tasks-design.md §9.1): the shapes the REST doors answer with
// (src/apiserver/src/schedules/schedule-views.ts), transcribed from OrbitKit's Models/ScheduleModels.swift. Read
// leniently and by hand: a closed set is a String here, so a state or reason a newer server adds costs one word, not
// the list; a field the Swift decoder requires makes its element unreadable (null), and an unreadable array element
// is dropped, never the whole list. The display rules (`ScheduleDisplay`) say what each one draws.

/** A string member, only when it is a JSON string. */
internal fun JsonObject.scheduleText(key: String): String? = (get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content
/** A whole-number member (Swift's `Int` reads 7 and 7.0), never a string. */
internal fun JsonObject.scheduleInt(key: String): Int? = (get(key) as? JsonPrimitive)?.takeIf { !it.isString }
    ?.let { it.intOrNull ?: it.doubleOrNull?.takeIf { d -> d == Math.floor(d) && !d.isInfinite() }?.toInt() }
internal fun JsonObject.scheduleBool(key: String): Boolean? = (get(key) as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull
internal fun JsonObject.scheduleDouble(key: String): Double? = (get(key) as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull
internal fun JsonObject.scheduleObject(key: String): JsonObject? = get(key) as? JsonObject
/** A list of strings, or null when it is missing or any element is not one (Swift's `[String]`). */
internal fun JsonObject.scheduleStrings(key: String): List<String>? = (get(key) as? JsonArray)
    ?.map { (it as? JsonPrimitive)?.takeIf { p -> p.isString }?.content ?: return null }
/** An array read element by element: one that does not parse is dropped. Null when the member is not an array. */
internal fun <T> JsonObject.scheduleList(key: String, parse: (JsonElement?) -> T?): List<T>? =
    (get(key) as? JsonArray)?.mapNotNull(parse)

/** A schedule's rule: one slot, every day, some days of the week, or whenever its condition fires
 * (docs/condition-triggers-design.md §6.1). */
sealed class ScheduleRule {
    data class Once(val at: String) : ScheduleRule()
    data class Daily(override val time: String) : ScheduleRule()
    data class Weekly(override val time: String, val weekdays: List<String>) : ScheduleRule()
    /** Sub-daily: a slot every [minutes] from [time] through [until] (inclusive; the end of the day when null), on [weekdays]. The
     * server always writes `time` and `weekdays`, so a build that predates EVERY reads it as a [Weekly] rule. */
    data class Every(val minutes: Int, override val time: String, val weekdays: List<String>, val until: String? = null) : ScheduleRule()
    /** A WHEN rule: starts a run each time its condition fires. [conditionId] is null on a create card, before Create writes the
     * condition. */
    data class When(val conditionId: String?, val runsPerWeek: Int, override val condition: ScheduleWhenCondition) : ScheduleRule()

    /** The slot's wall-clock time; a one-off and a WHEN rule have none. */
    open val time: String? get() = null

    /** A WHEN rule's condition; null for a timed rule. */
    open val condition: ScheduleWhenCondition? get() = null

    fun toJson(): JsonObject = buildJsonObject {
        when (this@ScheduleRule) {
            is Once -> { put("kind", "ONCE"); put("at", at) }
            is Daily -> { put("kind", "DAILY"); put("time", time) }
            is Weekly -> { put("kind", "WEEKLY"); put("time", time); put("weekdays", JsonArray(weekdays.map(::JsonPrimitive))) }
            is Every -> {
                put("kind", "EVERY"); put("minutes", minutes); put("time", time)
                put("weekdays", JsonArray(weekdays.map(::JsonPrimitive))); until?.let { put("until", it) }
            }
            is When -> { put("kind", "WHEN"); put("conditionId", conditionId); put("runsPerWeek", runsPerWeek); put("condition", condition.toJson()) }
        }
    }

    companion object {
        /** ONCE, DAILY, EVERY and WHEN by name; any other kind is weekly, as the Swift decoder reads it. An EVERY rule without a
         * readable `minutes` falls to that same weekly reading, so it is never dropped. */
        fun parse(json: JsonElement?): ScheduleRule? {
            val o = json as? JsonObject ?: return null
            return when (o.scheduleText("kind") ?: return null) {
                "ONCE" -> Once(o.scheduleText("at") ?: return null)
                "DAILY" -> Daily(o.scheduleText("time") ?: return null)
                "WHEN" -> When(o.scheduleText("conditionId"), o.scheduleInt("runsPerWeek") ?: 0,
                    ScheduleWhenCondition.parse(o["condition"]) ?: return null)
                "EVERY" -> o.scheduleInt("minutes")?.takeIf { it > 0 }?.let { minutes ->
                    Every(minutes, o.scheduleText("time") ?: return null, o.scheduleStrings("weekdays") ?: emptyList(), o.scheduleText("until"))
                } ?: Weekly(o.scheduleText("time") ?: return null, o.scheduleStrings("weekdays") ?: emptyList())
                else -> Weekly(o.scheduleText("time") ?: return null, o.scheduleStrings("weekdays") ?: emptyList())
            }
        }
    }
}

/** What the owner allowed: where it runs, what it may do, how often and how long. */
data class ScheduleEnvelope(val workspaceId: String, val accessLevel: String, val runsPerWeek: Int, val runLimitMinutes: Int,
    /** A WHEN rule's approved probe command, as its sha256; null for a timed schedule. */
    val commandHash: String? = null) {
    companion object {
        fun parse(json: JsonElement?): ScheduleEnvelope? {
            val o = json as? JsonObject ?: return null
            return ScheduleEnvelope(o.scheduleText("workspaceId") ?: return null, o.scheduleText("accessLevel") ?: return null,
                o.scheduleInt("runsPerWeek") ?: return null, o.scheduleInt("runLimitMinutes") ?: return null, o.scheduleText("commandHash"))
        }
    }
}

/** Where a run's session stands in the history (§7.4). */
data class ScheduleRunSessionRef(val id: String, val state: String) {
    companion object {
        fun parse(json: JsonElement?): ScheduleRunSessionRef? {
            val o = json as? JsonObject ?: return null
            return ScheduleRunSessionRef(o.scheduleText("id") ?: return null, o.scheduleText("state") ?: return null)
        }
    }
}

/** One run: `GET /schedules/:id/runs`, a row's `lastRun`, the inspector's `recentRuns`. */
data class ScheduleRunView(
    val id: String,
    val scheduleId: String,
    val scheduleRevision: Int = 1,
    val plannedAt: String,
    val trigger: String = "SCHEDULED",
    val state: String,
    val attempt: Int = 1,
    val startedAt: String? = null,
    val endedAt: String? = null,
    val sessionId: String? = null,
    val key: String? = null,
    val summary: String? = null,
    val failureReason: String? = null,
    val heldReason: String? = null,
    /** S2d: the server's own line for why the run did not happen; preferred over the client's words. */
    val reasonText: String? = null,
    val session: ScheduleRunSessionRef? = null,
    /** The list's timeline runs only: whether its finding was new, and whether the owner was told. Null from the other
     * reads, where `ScheduleDisplay.runFindingFacts` works it out from findings. */
    val newFinding: Boolean? = null,
    val notified: Boolean? = null,
) {
    companion object {
        fun parse(json: JsonElement?): ScheduleRunView? {
            val o = json as? JsonObject ?: return null
            return ScheduleRunView(
                id = o.scheduleText("id") ?: return null,
                scheduleId = o.scheduleText("scheduleId") ?: return null,
                scheduleRevision = o.scheduleInt("scheduleRevision") ?: 1,
                plannedAt = o.scheduleText("plannedAt") ?: return null,
                trigger = o.scheduleText("trigger") ?: "SCHEDULED",
                state = o.scheduleText("state") ?: return null,
                attempt = o.scheduleInt("attempt") ?: 1,
                startedAt = o.scheduleText("startedAt"),
                endedAt = o.scheduleText("endedAt"),
                sessionId = o.scheduleText("sessionId"),
                key = o.scheduleText("key"),
                summary = o.scheduleText("summary"),
                failureReason = o.scheduleText("failureReason"),
                heldReason = o.scheduleText("heldReason"),
                reasonText = o.scheduleText("reasonText"),
                session = ScheduleRunSessionRef.parse(o["session"]),
                newFinding = o.scheduleBool("newFinding"),
                notified = o.scheduleBool("notified"),
            )
        }
    }
}

/** A schedule as the list and the inspector read it; the list's rows carry `lastRun` too. */
data class ScheduleView(
    val id: String,
    val title: String,
    val intent: String = "",
    val prompt: String = "",
    val rule: ScheduleRule,
    val timezone: String,
    val workspaceId: String,
    val workspaceName: String? = null,
    val agentId: String? = null,
    /** S5: the agent's name, so a hold can say 'the agent "auditor" is disabled'; null when it names none or is gone. */
    val agentName: String? = null,
    /** S5: the engine its runs start on ("codex"), when the conversation it came from still names one. */
    val engine: String? = null,
    val accessLevel: String = "CHECK_ONLY",
    val runLimitMinutes: Int = 30,
    val runsPerWeek: Int = 7,
    val envelope: ScheduleEnvelope = ScheduleEnvelope(workspaceId, accessLevel, runsPerWeek, runLimitMinutes),
    val state: String = "ACTIVE",
    val heldReason: String? = null,
    val endedReason: String? = null,
    val note: String? = null,
    val revision: Int = 1,
    val startAt: String? = null,
    val endAt: String? = null,
    /** The planned end by count (§8.5); null without one. */
    val maxRuns: Int? = null,
    val runsStarted: Int? = null,
    /** maxRuns minus runsStarted, at least 0; null without maxRuns or from a server before it. */
    val runsLeft: Int? = null,
    val nextDueAt: String? = null,
    val consecutiveFailures: Int = 0,
    val createdFromSessionId: String? = null,
    val createdAt: String = "2026-11-10T00:00:00.000Z",
    val endedAt: String? = null,
    /** The list's rows only. */
    val lastRun: ScheduleRunView? = null,
    /** The list's rows only: when a PAUSED schedule was paused. */
    val pausedAt: String? = null,
    /** A WHEN rule's condition and its newest reading; null for a timed schedule. */
    val condition: ScheduleConditionReading? = null,
) {
    companion object {
        fun parse(json: JsonElement?): ScheduleView? {
            val o = json as? JsonObject ?: return null
            val workspaceId = o.scheduleText("workspaceId") ?: return null
            val accessLevel = o.scheduleText("accessLevel") ?: "CHECK_ONLY"
            val runLimitMinutes = o.scheduleInt("runLimitMinutes") ?: 30
            val runsPerWeek = o.scheduleInt("runsPerWeek") ?: 7
            return ScheduleView(
                id = o.scheduleText("id") ?: return null,
                title = o.scheduleText("title") ?: return null,
                intent = o.scheduleText("intent") ?: "",
                prompt = o.scheduleText("prompt") ?: "",
                rule = ScheduleRule.parse(o["rule"]) ?: return null,
                timezone = o.scheduleText("timezone") ?: "UTC",
                workspaceId = workspaceId,
                workspaceName = o.scheduleText("workspaceName"),
                agentId = o.scheduleText("agentId"),
                agentName = o.scheduleText("agentName"),
                engine = o.scheduleText("engine"),
                accessLevel = accessLevel,
                runLimitMinutes = runLimitMinutes,
                runsPerWeek = runsPerWeek,
                envelope = ScheduleEnvelope.parse(o["envelope"]) ?: ScheduleEnvelope(workspaceId, accessLevel, runsPerWeek, runLimitMinutes),
                state = o.scheduleText("state") ?: "ACTIVE",
                heldReason = o.scheduleText("heldReason"),
                endedReason = o.scheduleText("endedReason"),
                note = o.scheduleText("note"),
                revision = o.scheduleInt("revision") ?: 1,
                startAt = o.scheduleText("startAt"),
                endAt = o.scheduleText("endAt"),
                maxRuns = o.scheduleInt("maxRuns"),
                runsStarted = o.scheduleInt("runsStarted"),
                runsLeft = o.scheduleInt("runsLeft"),
                nextDueAt = o.scheduleText("nextDueAt"),
                consecutiveFailures = o.scheduleInt("consecutiveFailures") ?: 0,
                createdFromSessionId = o.scheduleText("createdFromSessionId"),
                createdAt = o.scheduleText("createdAt") ?: "",
                endedAt = o.scheduleText("endedAt"),
                lastRun = ScheduleRunView.parse(o["lastRun"]),
                pausedAt = o.scheduleText("pausedAt"),
                condition = ScheduleConditionReading.parse(o["condition"]),
            )
        }
    }
}

/** `GET /schedules`. A row this build cannot read is dropped, not the list. */
data class ScheduleListResponse(
    val schedules: List<ScheduleView>,
    /** The runs of the page's window, for every listed schedule: each run under way, and the ended runs planned in the
     * last 24 hours. Null from a server before W2, where the page reads each schedule's detail instead. */
    val runs: List<ScheduleRunView>? = null,
    /** The OPEN tasks waiting for their startWhen condition (condition-triggers board ④); null from a server before conditions. */
    val waitingTasks: List<ScheduleWaitingTask>? = null,
) {
    companion object {
        fun parse(json: JsonElement?): ScheduleListResponse? {
            val o = json as? JsonObject ?: return null
            return ScheduleListResponse(o.scheduleList("schedules", ScheduleView::parse) ?: return null,
                o.scheduleList("runs", ScheduleRunView::parse), o.scheduleList("waitingTasks", ScheduleWaitingTask::parse))
        }
    }
}

data class ScheduleFindingView(
    val key: String,
    val summary: String? = null,
    val firstRunId: String? = null,
    val lastSeenRunId: String? = null,
    val notifiedAt: String? = null,
    val baseline: Boolean? = null,
    val createdAt: String? = null,
) {
    companion object {
        fun parse(json: JsonElement?): ScheduleFindingView? {
            val o = json as? JsonObject ?: return null
            return ScheduleFindingView(o.scheduleText("key") ?: return null, o.scheduleText("summary"), o.scheduleText("firstRunId"),
                o.scheduleText("lastSeenRunId"), o.scheduleText("notifiedAt"), o.scheduleBool("baseline"), o.scheduleText("createdAt"))
        }
    }
}

data class ScheduleUsageView(val since: String? = null, val runs: Int, val minutes: Int, val costUsd: Double? = null) {
    companion object {
        fun parse(json: JsonElement?): ScheduleUsageView? {
            val o = json as? JsonObject ?: return null
            return ScheduleUsageView(o.scheduleText("since"), o.scheduleInt("runs") ?: return null,
                o.scheduleInt("minutes") ?: return null, o.scheduleDouble("costUsd"))
        }
    }
}

/** A record's Undo: the door to post, and the revision it undoes (the wire's `body.revision`). */
data class ScheduleUndoDoor(val path: String, val revision: Int) {
    companion object {
        fun parse(json: JsonElement?): ScheduleUndoDoor? {
            val o = json as? JsonObject ?: return null
            return ScheduleUndoDoor(o.scheduleText("path") ?: return null, o.scheduleObject("body")?.scheduleInt("revision") ?: return null)
        }
    }
}

/** A change's record: in the inspector's history and as the change line in the session that made it. */
data class ScheduleChangeRecord(
    val scheduleId: String,
    val title: String,
    val revision: Int,
    val changedBy: String,
    val sessionId: String? = null,
    val before: JsonObject?,
    val after: JsonObject,
    val undoOfRevision: Int? = null,
    val undoneByRevision: Int? = null,
    /** The person's words that asked for it, when it came from the schedule's change conversation (§8.2). */
    val askedText: String? = null,
    val createdAt: String = "2026-11-14T10:00:00.000Z",
    val undo: ScheduleUndoDoor? = null,
) {
    val id: String get() = "$scheduleId@$revision"

    companion object {
        fun parse(json: JsonElement?): ScheduleChangeRecord? {
            val o = json as? JsonObject ?: return null
            return ScheduleChangeRecord(
                scheduleId = o.scheduleText("scheduleId") ?: return null,
                title = o.scheduleText("title") ?: "",
                revision = o.scheduleInt("revision") ?: return null,
                changedBy = o.scheduleText("changedBy") ?: "USER",
                sessionId = o.scheduleText("sessionId"),
                before = o.scheduleObject("before"),
                after = o.scheduleObject("after") ?: JsonObject(emptyMap()),
                undoOfRevision = o.scheduleInt("undoOfRevision"),
                undoneByRevision = o.scheduleInt("undoneByRevision"),
                askedText = o.scheduleText("askedText"),
                createdAt = o.scheduleText("createdAt") ?: "",
                undo = ScheduleUndoDoor.parse(o["undo"]),
            )
        }
    }
}

/**
 * Orbit's opening of a change conversation (§8.2): the schedule as it was when the conversation was opened, drawn
 * from `ScheduleCopy.ChangeConversation`. Kept on the session, so it still reads as the start of the conversation
 * after the schedule has changed.
 */
data class ScheduleChangeOpening(
    val scheduleId: String,
    val title: String,
    val revision: Int,
    /** The read-back ("What it does"). */
    val does: String = "",
    /** "Every day at 09:00 · Asia/Shanghai". */
    val `when`: String = "",
    /** "apiserver · Codex agent". */
    val runsIn: String = "",
    /** "Open a PR · edits in its own worktree and opens a PR; can't merge or deploy". */
    val may: String = "",
    /** "Up to 7 runs a week, 30 min each". */
    val costs: String = "",
) {
    companion object {
        fun parse(json: JsonElement?): ScheduleChangeOpening? {
            val o = json as? JsonObject ?: return null
            return ScheduleChangeOpening(
                scheduleId = o.scheduleText("scheduleId") ?: return null,
                title = o.scheduleText("title") ?: return null,
                revision = o.scheduleInt("revision") ?: return null,
                does = o.scheduleText("does") ?: "",
                `when` = o.scheduleText("when") ?: "",
                runsIn = o.scheduleText("runsIn") ?: "",
                may = o.scheduleText("may") ?: "",
                costs = o.scheduleText("costs") ?: "",
            )
        }
    }
}

/** One row of the opening's key/value box. */
data class ScheduleChangeOpeningRow(val label: String, val text: String)

/** The opening's rows, in order, as label and text. */
fun scheduleChangeOpeningRows(opening: ScheduleChangeOpening): List<ScheduleChangeOpeningRow> = listOf(
    ScheduleChangeOpeningRow(ScheduleCopy.ChangeConversation.does, opening.does),
    ScheduleChangeOpeningRow(ScheduleCopy.ChangeConversation.`when`, opening.`when`),
    ScheduleChangeOpeningRow(ScheduleCopy.ChangeConversation.runsIn, opening.runsIn),
    ScheduleChangeOpeningRow(ScheduleCopy.ChangeConversation.may, opening.may),
    ScheduleChangeOpeningRow(ScheduleCopy.ChangeConversation.costs, opening.costs),
)

/**
 * `GET /schedules/:id/change`: the schedule's open change conversation if it has one, and the opening a new one
 * would start with.
 */
data class ScheduleChangeConversationResponse(val sessionId: String?, val opening: ScheduleChangeOpening) {
    companion object {
        fun parse(json: JsonElement?): ScheduleChangeConversationResponse? {
            val o = json as? JsonObject ?: return null
            return ScheduleChangeConversationResponse(o.scheduleText("sessionId"),
                ScheduleChangeOpening.parse(o["opening"]) ?: return null)
        }
    }
}

/** `POST /schedules/:id/change {text}`: the conversation the words went to; [created] is false when another device
 * opened it meanwhile (the words were said in it, not lost). */
data class ScheduleChangeAnswer(val sessionId: String, val created: Boolean) {
    companion object {
        fun parse(json: JsonElement?): ScheduleChangeAnswer? {
            val o = json as? JsonObject ?: return null
            return ScheduleChangeAnswer(o.scheduleText("sessionId") ?: return null, o.scheduleBool("created") ?: true)
        }
    }
}

data class ScheduleCardDecision(val allow: String, val decline: String) {
    companion object {
        fun parse(json: JsonElement?): ScheduleCardDecision? {
            val o = json as? JsonObject ?: return null
            return ScheduleCardDecision(o.scheduleText("allow") ?: return null, o.scheduleText("decline") ?: return null)
        }
    }
}

/** A card's three envelope lines — Runs in, May, Costs — as the server words and keys them. */
data class ScheduleEnvelopeLines(val runsIn: RunsIn, val may: May, val costs: Costs) {
    data class RunsIn(val workspaceId: String, val workspaceName: String?, val engine: String?) {
        companion object {
            fun parse(json: JsonElement?): RunsIn? {
                val o = json as? JsonObject ?: return null
                return RunsIn(o.scheduleText("workspaceId") ?: return null, o.scheduleText("workspaceName"), o.scheduleText("engine"))
            }
        }
    }
    data class May(val accessLevel: String) {
        companion object {
            fun parse(json: JsonElement?): May? = (json as? JsonObject)?.scheduleText("accessLevel")?.let(::May)
        }
    }
    data class Costs(val runsPerWeek: Int, val runLimitMinutes: Int) {
        companion object {
            fun parse(json: JsonElement?): Costs? {
                val o = json as? JsonObject ?: return null
                return Costs(o.scheduleInt("runsPerWeek") ?: return null, o.scheduleInt("runLimitMinutes") ?: return null)
            }
        }
    }

    /** The envelope these lines describe, for the display rules. */
    val envelope: ScheduleEnvelope get() = ScheduleEnvelope(runsIn.workspaceId, may.accessLevel, costs.runsPerWeek, costs.runLimitMinutes)

    companion object {
        fun parse(json: JsonElement?): ScheduleEnvelopeLines? {
            val o = json as? JsonObject ?: return null
            return ScheduleEnvelopeLines(RunsIn.parse(o["runsIn"]) ?: return null, May.parse(o["may"]) ?: return null,
                Costs.parse(o["costs"]) ?: return null)
        }
    }
}

/** A create card's When. [condition] is a WHEN rule's lines: the condition, the re-arm and how it is checked, and the command; null
 * for a timed rule. */
data class ScheduleCardWhen(val rule: ScheduleRule, val timezone: String?, val firstRunAt: String?, val condition: ScheduleWhenLines? = null) {
    companion object {
        fun parse(json: JsonElement?): ScheduleCardWhen? {
            val o = json as? JsonObject ?: return null
            return ScheduleCardWhen(ScheduleRule.parse(o["rule"]) ?: return null, o.scheduleText("timezone"), o.scheduleText("firstRunAt"),
                ScheduleWhenLines.parse(o["condition"]))
        }
    }
}

/** A create card's Today: what the agent found when it did the work once before asking (D2). */
data class ScheduleCardToday(val key: String, val summary: String?) {
    companion object {
        fun parse(json: JsonElement?): ScheduleCardToday? {
            val o = json as? JsonObject ?: return null
            return ScheduleCardToday(o.scheduleText("key") ?: return null, o.scheduleText("summary"))
        }
    }
}

data class ScheduleCardEnvelope(val widens: List<String>, val now: ScheduleEnvelopeLines?, val asked: ScheduleEnvelopeLines) {
    companion object {
        fun parse(json: JsonElement?): ScheduleCardEnvelope? {
            val o = json as? JsonObject ?: return null
            return ScheduleCardEnvelope(o.scheduleStrings("widens") ?: return null, ScheduleEnvelopeLines.parse(o["now"]),
                ScheduleEnvelopeLines.parse(o["asked"]) ?: return null)
        }
    }
}

/**
 * A card the owner answers: the create card (§8.1, `kind` CREATE) or the envelope card (§4, `kind` UPDATE). One shape,
 * because the server sends one: a create card fills When / Runs in / May / Costs / Today, an envelope card fills
 * `envelope` and `proposed`.
 */
data class ScheduleCard(
    val id: String,
    val kind: String,
    val state: String = "PENDING",
    val askedBy: String? = "SESSION",
    val askedBySessionId: String? = null,
    val scheduleId: String? = null,
    val createdAt: String = "2026-11-14T10:00:00.000Z",
    val decidedAt: String? = null,
    val resultRevision: Int? = null,
    val decision: ScheduleCardDecision? = null,
    val title: String? = null,
    val readBack: String? = null,
    val intent: String? = null,
    val `when`: ScheduleCardWhen? = null,
    val runsIn: ScheduleEnvelopeLines.RunsIn? = null,
    val may: ScheduleEnvelopeLines.May? = null,
    val costs: ScheduleEnvelopeLines.Costs? = null,
    val today: ScheduleCardToday? = null,
    /** A create card's last line as the server words it (S5's `scheduleCreateNotice`); null from an envelope card. */
    val notice: String? = null,
    val proposed: JsonObject? = null,
    val envelope: ScheduleCardEnvelope? = null,
) {
    val isCreate: Boolean get() = kind == "CREATE"
    val isPending: Boolean get() = state == "PENDING"

    companion object {
        fun parse(json: JsonElement?): ScheduleCard? {
            val o = json as? JsonObject ?: return null
            return ScheduleCard(
                id = o.scheduleText("id") ?: return null,
                kind = o.scheduleText("kind") ?: return null,
                state = o.scheduleText("state") ?: "PENDING",
                askedBy = o.scheduleText("askedBy"),
                askedBySessionId = o.scheduleText("askedBySessionId"),
                scheduleId = o.scheduleText("scheduleId"),
                createdAt = o.scheduleText("createdAt") ?: "",
                decidedAt = o.scheduleText("decidedAt"),
                resultRevision = o.scheduleInt("resultRevision"),
                decision = ScheduleCardDecision.parse(o["decision"]),
                title = o.scheduleText("title"),
                readBack = o.scheduleText("readBack"),
                intent = o.scheduleText("intent"),
                `when` = ScheduleCardWhen.parse(o["when"]),
                runsIn = ScheduleEnvelopeLines.RunsIn.parse(o["runsIn"]),
                may = ScheduleEnvelopeLines.May.parse(o["may"]),
                costs = ScheduleEnvelopeLines.Costs.parse(o["costs"]),
                today = ScheduleCardToday.parse(o["today"]),
                notice = o.scheduleText("notice"),
                proposed = o.scheduleObject("proposed"),
                envelope = ScheduleCardEnvelope.parse(o["envelope"]),
            )
        }
    }
}

/** `GET /schedules/:id`: the inspector. */
data class ScheduleDetailResponse(
    val schedule: ScheduleView,
    val readBack: String? = null,
    val lastRun: ScheduleRunView? = null,
    val recentRuns: List<ScheduleRunView> = emptyList(),
    val findings: List<ScheduleFindingView> = emptyList(),
    val usage: ScheduleUsageView? = null,
    val history: List<ScheduleChangeRecord> = emptyList(),
    val pendingCards: List<ScheduleCard> = emptyList(),
) {
    companion object {
        fun parse(json: JsonElement?): ScheduleDetailResponse? {
            val o = json as? JsonObject ?: return null
            return ScheduleDetailResponse(
                schedule = ScheduleView.parse(o["schedule"]) ?: return null,
                readBack = o.scheduleText("readBack"),
                lastRun = ScheduleRunView.parse(o["lastRun"]),
                recentRuns = o.scheduleList("recentRuns", ScheduleRunView::parse).orEmpty(),
                findings = o.scheduleList("findings", ScheduleFindingView::parse).orEmpty(),
                usage = ScheduleUsageView.parse(o["usage"]),
                history = o.scheduleList("history", ScheduleChangeRecord::parse).orEmpty(),
                pendingCards = o.scheduleList("pendingCards", ScheduleCard::parse).orEmpty(),
            )
        }
    }
}

/** `POST /schedules/:id/{pause,resume}`, `DELETE /schedules/:id`. */
data class ScheduleControlAnswer(val schedule: ScheduleView, val record: ScheduleChangeRecord?) {
    companion object {
        fun parse(json: JsonElement?): ScheduleControlAnswer? {
            val o = json as? JsonObject ?: return null
            return ScheduleControlAnswer(ScheduleView.parse(o["schedule"]) ?: return null, ScheduleChangeRecord.parse(o["record"]))
        }
    }
}

/** `POST /schedules/:id/run`, `POST /schedule-runs/:id/stop`. */
data class ScheduleRunAnswer(val run: ScheduleRunView) {
    companion object {
        fun parse(json: JsonElement?): ScheduleRunAnswer? = ScheduleRunView.parse((json as? JsonObject)?.get("run"))?.let(::ScheduleRunAnswer)
    }
}

/** `POST /schedules/:id/undo` and `…/rename`: APPLIED, UNCHANGED or PENDING (a card, when undoing would widen). */
data class ScheduleUpdateAnswer(val outcome: String, val schedule: ScheduleView?, val card: ScheduleCard?) {
    companion object {
        fun parse(json: JsonElement?): ScheduleUpdateAnswer? {
            val o = json as? JsonObject ?: return null
            return ScheduleUpdateAnswer(o.scheduleText("outcome") ?: return null, ScheduleView.parse(o["schedule"]), ScheduleCard.parse(o["card"]))
        }
    }
}

data class ScheduleRunTry(val sessionId: String, val startedAt: String, val claimed: Boolean, val reachedEngine: Boolean) {
    companion object {
        fun parse(json: JsonElement?): ScheduleRunTry? {
            val o = json as? JsonObject ?: return null
            return ScheduleRunTry(o.scheduleText("sessionId") ?: return null, o.scheduleText("startedAt") ?: return null,
                o.scheduleBool("claimed") ?: return null, o.scheduleBool("reachedEngine") ?: return null)
        }
    }
}

data class ScheduleRunQueueGate(
    val queuedReason: String,
    val queuedActive: Int?,
    val queuedLimit: Int?,
    val queuedHeldByJobs: Int?,
    val since: String,
    val deadline: String,
) {
    companion object {
        fun parse(json: JsonElement?): ScheduleRunQueueGate? {
            val o = json as? JsonObject ?: return null
            return ScheduleRunQueueGate(o.scheduleText("queuedReason") ?: return null, o.scheduleInt("queuedActive"),
                o.scheduleInt("queuedLimit"), o.scheduleInt("queuedHeldByJobs"),
                o.scheduleText("since") ?: return null, o.scheduleText("deadline") ?: return null)
        }
    }
}

data class ScheduleRunSessionStatus(
    val tries: List<ScheduleRunTry>,
    val thisTry: Int?,
    val gaveUpAt: String?,
    val notBeforeAt: String?,
    val nextDueAt: String?,
    val queue: ScheduleRunQueueGate?,
) {
    internal val currentTry: ScheduleRunTry? get() = thisTry?.takeIf { it > 0 }?.let { tries.getOrNull(it - 1) }

    companion object {
        fun parse(json: JsonElement?): ScheduleRunSessionStatus? {
            val o = json as? JsonObject ?: return null
            // thisTry indexes the original array, so dropping a malformed try would change its meaning.
            val tries = (o["tries"] as? JsonArray)?.map { ScheduleRunTry.parse(it) ?: return null } ?: return null
            return ScheduleRunSessionStatus(tries, o.scheduleInt("thisTry"), o.scheduleText("gaveUpAt"),
                o.scheduleText("notBeforeAt"), o.scheduleText("nextDueAt"), ScheduleRunQueueGate.parse(o["queue"]))
        }
    }
}

/** `GET /sessions/:id/schedule-cards`: the cards a conversation asked, its changes, and its scheduled run. */
data class SessionScheduleCardsResponse(
    /** A scheduled run's session: the run it serves, however old; null for any other session. */
    val run: ScheduleRunView? = null,
    val cards: List<ScheduleCard>,
    val records: List<ScheduleChangeRecord>,
    /**
     * A schedule's change conversation (§8.2): Orbit's opening, as the schedule was when it was opened, for its strip
     * and its first message. Null on every other session (and on servers before it).
     */
    val change: ScheduleChangeOpening? = null,
    val runStatus: ScheduleRunSessionStatus? = null,
) {
    val statusKind: ScheduleRunStatusKind? get() = run?.let { ScheduleRunStatusDisplay.kind(it, runStatus) }

    companion object {
        fun parse(json: JsonElement?): SessionScheduleCardsResponse? {
            val o = json as? JsonObject ?: return null
            return SessionScheduleCardsResponse(ScheduleRunView.parse(o["run"]), o.scheduleList("cards", ScheduleCard::parse).orEmpty(),
                o.scheduleList("records", ScheduleChangeRecord::parse).orEmpty(), ScheduleChangeOpening.parse(o["change"]),
                ScheduleRunSessionStatus.parse(o["runStatus"]))
        }
    }
}

/** What a press on a card came back with. */
sealed class ScheduleDecisionOutcome {
    data class Decided(val card: ScheduleCard?) : ScheduleDecisionOutcome()
    /** 409 SCHEDULE_REQUEST_STALE: Allow withdrew the card. Shown, never retried. */
    data class Stale(val message: String) : ScheduleDecisionOutcome()
}

/**
 * A Waiting on you item of one of the four kinds no session can file (schedule-attention.ts), read off the
 * owner-request list beside the kinds `OwnerRequest` reads: [parse] is null for any other kind.
 */
data class ScheduleWaitingItem(
    val id: String,
    /** SCHEDULE_FAILED, SCHEDULE_HELD, SCHEDULE_APPROVAL or SCHEDULE_WIDEN. */
    val kind: String,
    val state: String = "PENDING",
    val title: String = "",
    val why: String = "",
    val scheduleId: String,
    val scheduleRunId: String? = null,
    val approvalId: String? = null,
    val scheduleChangeRequestId: String? = null,
    val workspaceId: String? = null,
    val askedBySessionId: String? = null,
    val expiresAt: String? = null,
    val createdAt: String = "2026-11-14T02:41:00.000Z",
) {
    companion object {
        val KINDS: List<String> = listOf("SCHEDULE_FAILED", "SCHEDULE_HELD", "SCHEDULE_APPROVAL", "SCHEDULE_WIDEN")
        /** [KINDS] under OrbitKit's name. */
        val kinds: List<String> get() = KINDS

        fun parse(json: JsonElement?): ScheduleWaitingItem? {
            val o = json as? JsonObject ?: return null
            val kind = o.scheduleText("kind")?.takeIf { it in KINDS } ?: return null
            return ScheduleWaitingItem(
                id = o.scheduleText("id") ?: return null,
                kind = kind,
                state = o.scheduleText("state") ?: return null,
                title = o.scheduleText("title") ?: "",
                why = o.scheduleText("why") ?: "",
                scheduleId = o.scheduleText("scheduleId") ?: return null,
                scheduleRunId = o.scheduleText("scheduleRunId"),
                approvalId = o.scheduleText("approvalId"),
                scheduleChangeRequestId = o.scheduleText("scheduleChangeRequestId"),
                workspaceId = o.scheduleText("workspaceId"),
                askedBySessionId = o.scheduleText("askedBySessionId"),
                expiresAt = o.scheduleText("expiresAt"),
                createdAt = o.scheduleText("createdAt") ?: "",
            )
        }

        /** The schedule items of an owner-request list (`{"requests":[…]}`): every other kind is left to `OwnerRequest`. */
        fun fromRequestList(json: JsonElement?): List<ScheduleWaitingItem> =
            (json as? JsonObject)?.scheduleList("requests", ::parse).orEmpty()
    }
}
