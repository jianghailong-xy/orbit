package io.orbitd.android.core.cards

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * A bg_run job as its one card in the transcript (the owner's job-card board, file 350t1lTONlrPMjilBdXx7, choices A1 B1 C1 D1 E1 F1 and
 * rulings R1-R4 of 2026-11-21; web `lib/bgJobCard.ts` and `JobCard.tsx`, word for word). What the card says is joined by the job's id
 * (`bgj_…`) from four sources: the call's own receipt, the job's row in GET /sessions/:id/background, the wake turns the control plane
 * opened for it ([backgroundWake]), and the tail read route.
 */
object BgJob {
    /** Orbit's background-job tool, as every engine's MCP name for it reaches the transcript. */
    const val TOOL = "mcp__orbit__bg_run"

    // The words the card draws, the web's own (`JobCardCopyParityTest`).
    const val showFullOutput = "Show full output"
    const val stopTitle = "Stop this job?"
    const val stop = "Stop"
    const val cancel = "Cancel"
    const val whatTheAgentRead = "What the agent read"
    const val newOutput = "new output"
    const val killed = "killed"

    /** The pace the tail route documents (apiserver sessions.controller `backgroundJobTail`): 5 s after each answer, 30 s after a 503/504. */
    const val TAIL_PACE_MS = 5_000L
    const val TAIL_RETRY_MS = 30_000L
    /** How many of the output's lines an opened card shows before the reader asks for the rest. */
    const val OPEN_LINES = 40

    private val jobIdField = Regex("\"jobId\"\\s*:\\s*\"(bgj_[^\"\\s]+)\"")
    private val jobIdAny = Regex("\\b(bgj_[0-9a-zA-Z]+)\\b")
    private val startedAtField = Regex("\"startedAt\"\\s*:\\s*\"([^\"]+)\"")

    data class Receipt(val jobId: String, val startedAt: String?)

    /** What a bg_run call's receipt names: the job's id and when its runner started it. Null before it answers. */
    fun receipt(text: String?): Receipt? {
        if (text == null) return null
        val id = (jobIdField.find(text) ?: jobIdAny.find(text))?.groupValues?.get(1) ?: return null
        return Receipt(id, startedAtField.find(text)?.groupValues?.get(1))
    }

    /**
     * The launch pair the runner writes for every bg_run job (runner-go background_job.go `launchJob`): a `Bash` tool_use with
     * run_in_background, whose id is the job's own. It exists for the Background list; the job's card is the bg_run call, so the
     * transcript draws nothing for it.
     */
    fun isRunnerJobLaunch(name: String?, id: String?, input: Any?): Boolean =
        name == "Bash" && id?.startsWith("bgj_") == true && (input as? JsonObject)?.get("run_in_background")
            .let { (it as? JsonPrimitive)?.contentOrNull == "true" }

    /**
     * What of a wake the transcript still draws as a line: only its scheduled wakeups. A job's end, new output or stall draws nothing
     * there (board C1): its card says it. Null when nothing is left to draw.
     */
    fun wakeupsOnly(wake: JsonObject?): JsonObject? {
        if (wake == null || wake.objects("wakeups").isEmpty()) return null
        return if (wake.objects("jobs").isEmpty()) wake else JsonObject(wake + ("jobs" to JsonArray(emptyList())))
    }

    /** One time the job woke its agent: the job as that wake's block spelled it out, and the turn that carried it. */
    data class WakeSeen(
        val job: JsonObject,
        /** The wake blocks, exactly as the agent read them. */
        val text: String,
        /** When the wake turn was written. */
        val ts: String?,
        /** When the agent read it; null while it was never confirmed delivered. */
        val readAt: String?,
    )

    /** One turn as [wakesOf] reads it: its control-plane note, when it was written and whether it was delivered. */
    data class Turn(val note: String?, val ts: String?, val delivered: Boolean)

    /** The wake turns among [turns], by job id, oldest first. */
    fun wakesOf(turns: List<Turn>): Map<String, List<WakeSeen>> {
        val out = LinkedHashMap<String, MutableList<WakeSeen>>()
        turns.forEach { turn ->
            val wake = turn.note?.let(::backgroundWake) ?: return@forEach
            wake.objects("jobs").forEach { job ->
                val id = job.text("id") ?: return@forEach
                out.getOrPut(id) { mutableListOf() } += WakeSeen(job, wake.text("text").orEmpty(), turn.ts, if (turn.delivered) turn.ts else null)
            }
        }
        return out
    }

    /** The jobs a wake carries news of, by id. */
    fun jobIds(wake: JsonObject): List<String> = wake.objects("jobs").mapNotNull { it.text("id") }

    /**
     * Who stopped a killed job, in one line: the wording the wake glosses use for each reason (apiserver runner-api/background-job-wake.ts
     * `KILLED_BECAUSE`), cut to its first clause, and the board's own line for the agent's bg_kill. Null for a reason none of them names.
     */
    fun killedBy(reason: String?): String? = when (reason) {
        "requested" -> "Killed by the agent."
        "stopped_by_owner", "stop" -> "The person who owns this session stopped it from the app."
        "runner_shutdown" -> "The runner process hosting it stopped — a restart or a self-update — and the job was killed with it."
        "session_cancelled" -> "The session was cancelled, or handed to another runner process, and the job was killed with it."
        "not_allowed" -> "It never ran: this session's permission mode asked the owner first, and they did not allow it."
        else -> null
    }

    enum class Phase { RUNNING, DONE, FAILED, KILLED, UNKNOWN }

    data class State(
        val phase: Phase,
        val exitCode: Int? = null,
        /** Why a killed job was killed, as the runner names it. */
        val reason: String? = null,
        /** How long a running job had been quiet when its newest wake said so; null when it has not gone quiet. */
        val quietMs: Long? = null,
        /** When it ended, where something said. */
        val endedAt: String? = null,
    )

    private fun terminalOf(status: String?): String = when (status) { "killed" -> "killed"; "failed" -> "failed"; else -> "done" }

    /**
     * How the job stands. Its runner's terminal report wins (its row of the Background list), then its end's wake, then the tail read's
     * own status. A job nothing says ended is running while its session is live; on a session that is over, it can no longer be, and
     * nothing said how it ended.
     */
    fun state(shell: JsonObject?, wakes: List<WakeSeen>, tail: JsonObject?, live: Boolean): State {
        val endWake = wakes.lastOrNull { it.job.flag("ended") }
        val end = endWake?.job
        val tailEnded = tail?.takeIf { it.text("status") != null && it.text("status") != "running" }
        val exitCode = shell?.number("exitCode") ?: end?.number("exitCode") ?: tailEnded?.number("exitCode")
        val reason = shell?.text("reason") ?: end?.text("killReason")
        // The runner's report says when it ended; without one loaded, the wake its end opened was written then.
        val endedAt = shell?.text("endedAt") ?: endWake?.ts
        val terminal = shell?.text("terminal") ?: end?.let { terminalOf(it.text("status")) } ?: tailEnded?.let { terminalOf(it.text("status")) }
        if (terminal != null) {
            val phase = when {
                terminal == "killed" -> Phase.KILLED
                terminal == "failed" || (exitCode ?: 0) != 0 -> Phase.FAILED
                else -> Phase.DONE
            }
            return State(phase, if (phase == Phase.KILLED) null else exitCode, if (phase == Phase.KILLED) reason else null, null, endedAt)
        }
        val newest = wakes.lastOrNull()?.job
        val quietMs = newest?.obj("stall")?.let { (it["quietForMs"] as? JsonPrimitive)?.longOrNull ?: 0L }
        return State(if (live || shell?.text("status") == "running") Phase.RUNNING else Phase.UNKNOWN, quietMs = quietMs)
    }

    /**
     * The output the card shows. Running: what the tail read answered just now, else what the newest wake carried. Ended: what its end's
     * wake carried (R2), else the tail read's last answer, else the runner's end report.
     */
    fun output(phase: Phase, shell: JsonObject?, wakes: List<WakeSeen>, tail: JsonObject?): String {
        val polled = tail?.strings("lines").orEmpty().joinToString("\n")
        val newestTail = wakes.lastOrNull { !it.job.text("outputTail").isNullOrEmpty() }?.job?.text("outputTail").orEmpty()
        val text = if (phase == Phase.RUNNING || phase == Phase.UNKNOWN) polled.ifEmpty { newestTail } else {
            val endTail = wakes.lastOrNull { it.job.flag("ended") }?.job?.text("outputTail").orEmpty()
            endTail.ifEmpty { polled }.ifEmpty { shell?.text("latestOutput").orEmpty() }.ifEmpty { newestTail }
        }
        return stripAnsi(text)
    }

    private val ansi = Regex("\\u001B\\[[0-?]*[ -/]*[@-~]|\\u001B\\][^\\u0007\\u001B]*(?:\\u0007|\\u001B\\\\)")
    private fun stripAnsi(text: String) = ansi.replace(text, "")

    /** `12m 40s` / `3m 10s` / `40m` past twenty minutes / `1h 5m` / `45s`: how long the job has run. */
    fun elapsed(ms: Long): String {
        var seconds = maxOf(0L, ms / 1000)
        val hours = seconds / 3600
        seconds -= hours * 3600
        val minutes = seconds / 60
        seconds -= minutes * 60
        return when {
            hours > 0 -> "${hours}h ${minutes}m"
            minutes >= 20 -> "${minutes}m"
            minutes > 0 -> "${minutes}m ${seconds.toString().padStart(2, '0')}s"
            else -> "${seconds}s"
        }
    }

    /** Every line of some output, its trailing blank lines dropped; none for output that is only blank. */
    fun lines(text: String): List<String> = if (text.isBlank()) emptyList() else text.trimEnd().split("\n")

    /** The last [n] lines of some output. */
    fun lastLines(text: String, n: Int): List<String> = lines(text).takeLast(n)

    /** The amber chip of a job that has gone quiet while still running: `quiet 10m`. */
    fun quiet(ms: Long) = "quiet ${BackgroundWakeCard.duration(ms / 1000)}"

    fun exit(code: Int) = "exit $code"

    fun showAll(n: Int) = "Show all $n lines"

    fun woke(n: Int) = "Woke the agent $n ${if (n == 1) "time" else "times"}"

    /** One wake's row in the opened card: when, what it said, and when the agent read it. */
    fun wakeRow(wake: WakeSeen, zone: ZoneId = ZoneId.systemDefault()): String {
        val job = wake.job
        val stall = job.obj("stall")
        val what = when {
            stall != null -> quiet((stall["quietForMs"] as? JsonPrimitive)?.longOrNull ?: 0L)
            !job.flag("ended") -> newOutput
            job.text("status") == "killed" -> killed
            job.number("exitCode") != null -> exit(job.number("exitCode")!!)
            else -> job.text("status").orEmpty()
        }
        return listOfNotNull(wake.ts?.let { clock(it, zone) }, what, wake.readAt?.let { "read by the agent at ${clock(it, zone)}" })
            .filter { it.isNotEmpty() }.joinToString(" · ")
    }

    /** The opened card's metadata line: `bgj_… · watch · started 10:20 · ran 12m 40s · on workstation`. */
    fun meta(jobId: String?, kind: String, startMs: Long?, ranFor: String?, where: String?, zone: ZoneId = ZoneId.systemDefault()): String =
        listOfNotNull(jobId, kind, startMs?.let { "started ${clock(Instant.ofEpochMilli(it).toString(), zone)}" }, ranFor?.let { "ran $it" },
            where?.takeIf { it.isNotEmpty() }?.let { "on $it" }).joinToString(" · ")

    fun clock(iso: String, zone: ZoneId = ZoneId.systemDefault()): String = runCatching {
        DateTimeFormatter.ofPattern("HH:mm").withZone(zone).format(Instant.parse(iso))
    }.getOrDefault(iso)

    fun millis(iso: String?): Long? = iso?.let { runCatching { Instant.parse(it).toEpochMilli() }.getOrNull() }

    /** The kind bg_run was called with: job, watch or service. */
    fun kind(input: JsonObject?): String = input?.text("kind")?.takeIf { it.isNotEmpty() } ?: "job"

    /** The card's title: the job's description, else its command. */
    fun title(input: JsonObject?): String =
        input?.text("description")?.trim()?.takeIf { it.isNotEmpty() } ?: input?.text("command").orEmpty()

    /** Whether the person can stop it from here (R3): running, and its row of the Background list says its runner can. */
    fun stoppable(phase: Phase, shell: JsonObject?): Boolean = phase == Phase.RUNNING && shell?.flag("stoppable") == true

}
