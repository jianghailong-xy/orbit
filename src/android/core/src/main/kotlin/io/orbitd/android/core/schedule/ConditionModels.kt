package io.orbitd.android.core.schedule

import kotlinx.serialization.json.*

// Conditions (docs/condition-triggers-design.md): work that starts when something outside Orbit becomes true. The shapes
// the doors answer with, as `src/shared/src/condition.ts` types them, transcribed from OrbitKit's
// Models/ConditionModels.swift and read leniently: a state or kind a newer server adds costs one word, never the read. The
// rules over them are `ConditionDisplay`.

/** A comparison a condition's readings are held to: `GT` 90, or `EXIT_ZERO` with no value. */
data class ConditionCompare(val op: String, val value: Double?) {
    fun toJson(): JsonObject = buildJsonObject { put("op", op); put("value", value) }

    companion object {
        fun parse(json: JsonElement?): ConditionCompare? {
            val o = json as? JsonObject ?: return null
            return ConditionCompare(o.scheduleText("op") ?: return null, o.scheduleDouble("value"))
        }
    }
}

/** A WHEN rule's condition (shared `ScheduleWhenCondition`), every default written out. */
data class ScheduleWhenCondition(
    val text: String,
    val command: String,
    val compare: ConditionCompare,
    val holdSeconds: Int = 0,
    val rearm: ConditionCompare? = null,
    val intervalSeconds: Int = 300,
    val unit: String? = null,
    val timeoutSeconds: Int = 20,
    /** Fire again every this many seconds while it still holds; null fires once. */
    val repeatSeconds: Int? = null,
) {
    fun toJson(): JsonObject = buildJsonObject {
        put("text", text); put("command", command); put("compare", compare.toJson()); put("holdSeconds", holdSeconds)
        put("rearm", rearm?.toJson() ?: JsonNull); put("intervalSeconds", intervalSeconds); put("unit", unit)
        put("timeoutSeconds", timeoutSeconds); put("repeatSeconds", repeatSeconds)
    }

    companion object {
        fun parse(json: JsonElement?): ScheduleWhenCondition? {
            val o = json as? JsonObject ?: return null
            return ScheduleWhenCondition(
                text = o.scheduleText("text") ?: return null,
                command = o.scheduleText("command") ?: "",
                compare = ConditionCompare.parse(o["compare"]) ?: return null,
                holdSeconds = o.scheduleInt("holdSeconds") ?: 0,
                rearm = ConditionCompare.parse(o["rearm"]),
                intervalSeconds = o.scheduleInt("intervalSeconds") ?: 300,
                unit = o.scheduleText("unit"),
                timeoutSeconds = o.scheduleInt("timeoutSeconds") ?: 20,
                repeatSeconds = o.scheduleInt("repeatSeconds"),
            )
        }
    }
}

/** A WHEN schedule's condition, or a waiting task's, as a list shows it: the newest reading and its age (board ④). */
data class ScheduleConditionReading(
    val id: String,
    val text: String,
    val unit: String? = null,
    /** WAITING, HOLDING, FIRED, UNKNOWN or ENDED. */
    val state: String = "WAITING",
    val lastValue: Double? = null,
    val lastSampleAt: String? = null,
) {
    /** The probe cannot be read: the row is tagged Can't read at the head of Waiting for a condition (§5.3; owner 2026-11-19,
     * it no longer goes under Needs you). */
    val cantRead: Boolean get() = state == "UNKNOWN"

    companion object {
        fun parse(json: JsonElement?): ScheduleConditionReading? {
            val o = json as? JsonObject ?: return null
            return ScheduleConditionReading(o.scheduleText("id") ?: return null, o.scheduleText("text") ?: "", o.scheduleText("unit"),
                o.scheduleText("state") ?: "WAITING", o.scheduleDouble("lastValue"), o.scheduleText("lastSampleAt"))
        }
    }
}

/** A task that starts when its condition holds, as the Scheduled page lists it (shared `ScheduleWaitingTask`). */
data class ScheduleWaitingTask(
    val id: String,
    val title: String,
    val workspaceId: String,
    val workspaceName: String? = null,
    val condition: ScheduleConditionReading,
) {
    companion object {
        fun parse(json: JsonElement?): ScheduleWaitingTask? {
            val o = json as? JsonObject ?: return null
            return ScheduleWaitingTask(o.scheduleText("id") ?: return null, o.scheduleText("title") ?: return null,
                o.scheduleText("workspaceId") ?: return null, o.scheduleText("workspaceName"),
                ScheduleConditionReading.parse(o["condition"]) ?: return null)
        }
    }
}

/** A WHEN rule's lines on the create card, as the server words them (shared `ScheduleWhenLines`, board ③). */
data class ScheduleWhenLines(
    /** "Raw used above 90% for 10 min". */
    val text: String,
    /** "Fires again only after it drops below 85%. Checked every 5 min on workstation-gpu, no model." */
    val detail: String,
    /** The probe command, verbatim: what Create approves. */
    val command: String,
    /** "And again every 2 hours while it stays that way."; null with no repeat. */
    val repeat: String? = null,
    /** "Keeps this cloud workspace awake while it waits."; null off Orbit Cloud. */
    val awake: String? = null,
) {
    companion object {
        fun parse(json: JsonElement?): ScheduleWhenLines? {
            val o = json as? JsonObject ?: return null
            return ScheduleWhenLines(o.scheduleText("text") ?: return null, o.scheduleText("detail") ?: "", o.scheduleText("command") ?: "",
                o.scheduleText("repeat"), o.scheduleText("awake"))
        }
    }
}

/** One reading the runner reported. */
data class ConditionSampleView(val at: String, val outcome: String = "VALUE", val value: Double? = null, val exitCode: Int? = null) {
    companion object {
        fun parse(json: JsonElement?): ConditionSampleView? {
            val o = json as? JsonObject ?: return null
            return ConditionSampleView(o.scheduleText("at") ?: return null, o.scheduleText("outcome") ?: "VALUE", o.scheduleDouble("value"),
                o.scheduleInt("exitCode"))
        }
    }
}

/** One line of a condition's history: FIRED, READY_AGAIN, CANT_READ, READ_AGAIN, ASKED_STILL_WAITING. */
data class ConditionEventView(
    val at: String,
    val kind: String,
    val value: Double? = null,
    /** The run a FIRED started, on a WHEN schedule. */
    val runId: String? = null,
    /** A FIRED that is a repeat: "Fired again". */
    val repeat: Boolean = false,
) {
    companion object {
        fun parse(json: JsonElement?): ConditionEventView? {
            val o = json as? JsonObject ?: return null
            return ConditionEventView(o.scheduleText("at") ?: return null, o.scheduleText("kind") ?: return null, o.scheduleDouble("value"),
                o.scheduleText("runId"), o.scheduleBool("repeat") ?: false)
        }
    }
}

/** `GET /conditions/:id`: a condition's state, its newest samples and its events (the inspector's Condition and How it checks
 * blocks, and its history). */
data class ConditionView(
    val id: String,
    val workspaceId: String = "w1",
    val text: String,
    val unit: String? = null,
    val command: String,
    val timeoutSeconds: Int = 20,
    val compare: ConditionCompare,
    val holdSeconds: Int = 0,
    val rearm: ConditionCompare? = null,
    val intervalSeconds: Int = 300,
    val repeatSeconds: Int? = null,
    val state: String = "WAITING",
    val lastSampleAt: String? = null,
    val lastValue: Double? = null,
    val lastOutcome: String? = null,
    val lastReadAt: String? = null,
    val unknownReason: String? = null,
    val failedChecks: Int = 0,
    val firedAt: String? = null,
    val approvedAt: String = "2026-11-17T03:00:00.000Z",
    val taskId: String? = null,
    val scheduleId: String? = null,
    val keepsWorkspaceAwake: Boolean = false,
    /** The runner its probes run on; null from a server that does not say, or a workspace with none. */
    val runnerName: String? = null,
    /** Newest first. */
    val samples: List<ConditionSampleView> = emptyList(),
    /** Newest first. */
    val events: List<ConditionEventView> = emptyList(),
) {
    companion object {
        fun parse(json: JsonElement?): ConditionView? {
            val o = json as? JsonObject ?: return null
            val probe = o.scheduleObject("probe")
            return ConditionView(
                id = o.scheduleText("id") ?: return null,
                workspaceId = o.scheduleText("workspaceId") ?: "",
                text = o.scheduleText("text") ?: return null,
                unit = o.scheduleText("unit"),
                command = probe?.scheduleText("command") ?: "",
                timeoutSeconds = probe?.scheduleInt("timeoutSeconds") ?: 20,
                compare = ConditionCompare.parse(o["compare"]) ?: return null,
                holdSeconds = o.scheduleInt("holdSeconds") ?: 0,
                rearm = ConditionCompare.parse(o["rearm"]),
                intervalSeconds = o.scheduleInt("intervalSeconds") ?: 300,
                repeatSeconds = o.scheduleInt("repeatSeconds"),
                state = o.scheduleText("state") ?: "WAITING",
                lastSampleAt = o.scheduleText("lastSampleAt"),
                lastValue = o.scheduleDouble("lastValue"),
                lastOutcome = o.scheduleText("lastOutcome"),
                lastReadAt = o.scheduleText("lastReadAt"),
                unknownReason = o.scheduleText("unknownReason"),
                failedChecks = o.scheduleInt("failedChecks") ?: 0,
                firedAt = o.scheduleText("firedAt"),
                approvedAt = o.scheduleText("approvedAt") ?: "",
                taskId = o.scheduleText("taskId"),
                scheduleId = o.scheduleText("scheduleId"),
                keepsWorkspaceAwake = o.scheduleBool("keepsWorkspaceAwake") ?: false,
                runnerName = o.scheduleText("runnerName"),
                samples = o.scheduleList("samples", ConditionSampleView::parse).orEmpty(),
                events = o.scheduleList("events", ConditionEventView::parse).orEmpty(),
            )
        }
    }
}

/** One answer of the 30-day question: Keep waiting, Stop. */
data class ConditionOption(val label: String, val description: String = "")

/**
 * A Waiting on you item a condition files (§5.3, §6.2): the can't-read card (CONDITION_UNKNOWN) and the 30-day question
 * (CONDITION_STILL_WAITING), read off the owner-request list beside the kinds `OwnerRequest` reads: [parse] is null for any other
 * kind. Written by the condition, not asked by a session, so it is answered here and nowhere else.
 */
data class ConditionWaitingItem(
    val id: String,
    val kind: String,
    val state: String = "PENDING",
    /** "Can't read: Root disk below 5%" / "Still waiting for 3 or more OSDs are in. Keep waiting?". */
    val title: String,
    val why: String = "",
    val conditionId: String? = null,
    val workspaceId: String? = null,
    val askedBySessionId: String? = null,
    /** The 30-day question's two answers: Keep waiting, Stop. */
    val options: List<ConditionOption> = emptyList(),
    val createdAt: String = "2026-11-17T03:40:00.000Z",
) {
    val isStillWaiting: Boolean get() = kind == STILL_WAITING

    companion object {
        const val CANT_READ = "CONDITION_UNKNOWN"
        const val STILL_WAITING = "CONDITION_STILL_WAITING"
        val KINDS: List<String> = listOf(CANT_READ, STILL_WAITING)

        fun parse(json: JsonElement?): ConditionWaitingItem? {
            val o = json as? JsonObject ?: return null
            val kind = o.scheduleText("kind")?.takeIf { it in KINDS } ?: return null
            return ConditionWaitingItem(
                id = o.scheduleText("id") ?: return null,
                kind = kind,
                state = o.scheduleText("state") ?: return null,
                title = o.scheduleText("title") ?: "",
                why = o.scheduleText("why") ?: "",
                conditionId = o.scheduleText("conditionId"),
                workspaceId = o.scheduleText("workspaceId"),
                askedBySessionId = o.scheduleText("askedBySessionId"),
                options = o.scheduleList("options") { e ->
                    (e as? JsonObject)?.let { opt -> opt.scheduleText("label")?.let { ConditionOption(it, opt.scheduleText("description") ?: "") } }
                }.orEmpty(),
                createdAt = o.scheduleText("createdAt") ?: "",
            )
        }

        /** The condition items of an owner-request list (`{"requests":[…]}`): every other kind is left to `OwnerRequest`. */
        fun fromRequestList(json: JsonElement?): List<ConditionWaitingItem> =
            (json as? JsonObject)?.scheduleList("requests", ::parse).orEmpty()
    }
}

/** A task's startWhen on its read (shared `TaskStartWhenView`): what it waits for, the newest reading, and the waiting line while
 * it waits. */
data class TaskStartWhenView(
    val conditionId: String,
    val text: String,
    val unit: String? = null,
    val state: String = "WAITING",
    val lastValue: Double? = null,
    val lastSampleAt: String? = null,
    val firedAt: String? = null,
    /** "Waiting for: 3 or more OSDs are in" while it waits; null once it fired or ended. */
    val waitingLine: String? = null,
) {
    companion object {
        fun parse(json: JsonElement?): TaskStartWhenView? {
            val o = json as? JsonObject ?: return null
            return TaskStartWhenView(o.scheduleText("conditionId") ?: return null, o.scheduleText("text") ?: "", o.scheduleText("unit"),
                o.scheduleText("state") ?: "WAITING", o.scheduleDouble("lastValue"), o.scheduleText("lastSampleAt"),
                o.scheduleText("firedAt"), o.scheduleText("waitingLine"))
        }
    }
}

/** The task create card's condition lines (board frame 2; the server's `startWhenCardLines`): Starts when, how it is checked and
 * the command under it, Today, If never. */
data class StartWhenCardLines(
    val startsWhen: String,
    val checked: String,
    val command: String,
    val today: String,
    val ifNever: String,
    /** "Keeps this cloud workspace awake while it waits."; null off Orbit Cloud. */
    val awake: String? = null,
) {
    companion object {
        /** The lines off a JSON object (the card's `preview.tasks[i].startWhen`); null when it carries none. */
        fun parse(json: JsonElement?): StartWhenCardLines? {
            val o = json as? JsonObject ?: return null
            return StartWhenCardLines(o.scheduleText("startsWhen") ?: return null, o.scheduleText("checked") ?: "",
                o.scheduleText("command") ?: "", o.scheduleText("today") ?: "", o.scheduleText("ifNever") ?: "", o.scheduleText("awake"))
        }

        /** A task create card's lines (`input.preview.tasks[0].startWhen`); null for a card without one. */
        fun ofCreateInput(input: JsonObject?): StartWhenCardLines? =
            ((input?.get("preview") as? JsonObject)?.get("tasks") as? JsonArray)?.firstOrNull()
                ?.let { (it as? JsonObject)?.get("startWhen") }?.let(::parse)
    }
}
