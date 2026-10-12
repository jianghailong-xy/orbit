package io.orbitd.android.wiki

import java.time.Instant

// The server's runs on the Wiki page (design §2.2, mock 35 ④⑤; contract `jobs.read`, P9) — a port of the web's
// `src/web/src/lib/wikiRuns.ts` and OrbitKit `WikiRunsLogic`, word for word: the Runs band's rows — what kind of
// run, where it stands, how far it got and where it waits — and a run's call log, one model call a row. Both are
// held to `src/shared/src/wiki-server-execution.fixture.json` (`WikiServerExecutionFixtureTest` here,
// `lib/wikiRuns.test.ts` and `WikiServerExecutionCopyParityTests` at the other two ends).

/** Every word the Runs band, a run's page and the System model's state say. */
internal object WikiRunsCopy {
    const val runs = "Runs"
    const val none = "Nothing has run on the server yet."

    /** What a kind of run is called (`WIKI_RUN_KINDS`). */
    fun kind(kind: String?) = when (kind) {
        "verify" -> "Verification"; "articles" -> "Articles"; "import" -> "Import"
        "plan_draft" -> "Plan draft"; "plan_revise" -> "Plan revision"; "docs_build" -> "Documents"
        "maintain" -> "Maintenance"; "smoke" -> "Model check"
        else -> ""
    }

    const val queued = "Queued"
    const val running = "Running"
    const val waitingRunner = "Waiting for the runner"
    const val waitingModel = "Waiting for the System model"
    const val done = "Done"
    const val failed = "Failed"
    const val cancelled = "Cancelled"
    const val nextInLine = "next in line"
    const val starting = "starting"
    const val noResult = "It ended without a result"
    fun runsAhead(count: Int) = if (count == 1) "1 run ahead" else "$count runs ahead"
    fun waited(duration: String) = "waited $duration"
    fun retryingIn(duration: String) = "retrying in $duration"
    fun callsEnded(ended: Int, of: Int) = "$ended of $of calls ended"
    fun nextCall(ahead: Int, waited: String) = if (ahead == 0) "next call first in line, waited $waited" else "next call $ahead ahead, waited $waited"
    fun calls(count: Int) = if (count == 1) "1 call" else "${WikiArticleCopy.count(count)} calls"
    fun tokens(count: Int) = "${WikiArticleCopy.count(count)} tokens"
    fun took(duration: String) = "took $duration"
    fun started(ago: String) = "started $ago"

    // MARK: the call log

    /** The log itself: the table's name, and the section a run's page lists its calls under. */
    const val callsTitle = "Calls"
    const val call = "Call"
    const val callState = "State"
    const val callWaited = "Waited"
    const val callRan = "Ran"
    const val callTokens = "Tokens"
    const val callQueued = "Queued"
    const val callRunning = "Running"
    const val callDone = "Done"
    const val callFailed = "Failed"
    const val callCancelled = "Cancelled"
    const val noValue = "—"
    fun callAhead(ahead: Int) = if (ahead == 0) "Queued · next" else "Queued · $ahead ahead"
    fun retries(count: Int) = if (count == 1) "1 retry" else "$count retries"
    fun callTokens(input: Int, output: Int) = "${WikiArticleCopy.count(input)} → ${WikiArticleCopy.count(output)}"
    fun ran(duration: String) = "ran $duration"
    fun foot(calls: Int, input: Int, output: Int) = "${this.calls(calls)} · ${WikiArticleCopy.count(input)} tokens in, ${WikiArticleCopy.count(output)} out"
    const val soFar = "so far"
    fun showingLast(shown: Int) = "showing the last $shown"

    // MARK: the System model's state (mock 35 ③)

    /** A state as the settings page, Set up and the Runs band say it (`WIKI_MODEL_STATE_WORDS`). */
    fun modelState(state: String?) = when (state) {
        "up" -> "Up"; "down" -> "Unreachable"; "auth_failed" -> "Key refused"; "unconfigured" -> "Not configured"
        "worker_not_running" -> "wiki worker not running"; else -> ""
    }

    const val systemModel = "System model"
    /** `System model · qwen3.8-27b-fp8`, or the bare words while no model is named (`wikiSystemModelLabel`). */
    fun systemModelLabel(model: String?) = if (model.isNullOrEmpty()) systemModel else "$systemModel · $model"
}

/** One run's row on the Runs band (the web's `WikiRunRow`). */
internal data class WikiRunRow(
    val kind: String, val mark: Mark, val tone: Tone, val state: String,
    /** What follows the state, ` · ` between its parts; empty when there is nothing to add. */
    val text: String, val whenText: String,
) {
    /** ok: a green dot; warn: amber, it waits; error: red, it broke; spin: it runs; none: grey. */
    enum class Mark { OK, WARN, ERROR, SPIN, NONE }
    /** plain: the state in the label colour; warn: amber; error: red; muted: grey. */
    enum class Tone { PLAIN, WARN, ERROR, MUTED }
}

/** One row of a run's call log (the web's `WikiCallRow`). */
internal data class WikiCallRow(
    val call: String, val state: String, /** `1 retry`, beside the state, when the call was tried again. */
    val retries: String?, val tone: Tone, val waited: String, val ran: String, val tokens: String,
    /** The phone's second line: `waited 1s · ran 14s · 1,204 → 296 tokens`. */
    val line: String, val error: String?,
) {
    /** ok: green; warn: amber; error: red; run: blue; muted: grey. */
    enum class Tone { OK, WARN, ERROR, RUN, MUTED }
}

internal object WikiRunsLogic {
    /** How a model's state is coloured: up green; down amber — it comes back by itself; the rest red (`wikiModelTone`). */
    enum class ModelTone { UP, WARN, ERROR }
    fun modelTone(state: String?) = when (state) { "up" -> ModelTone.UP; "down" -> ModelTone.WARN; else -> ModelTone.ERROR }

    /** `41s`, `1m 12s`, `6m`, `1h 3m`, `2d 4h` — the web's `wikiDuration`. */
    fun duration(seconds: Double): String {
        val s = maxOf(0L, if (seconds.isFinite()) Math.floor(seconds).toLong() else 0L)
        return when {
            s < 60 -> "${s}s"
            s < 3600 -> if (s % 60 == 0L) "${s / 60}m" else "${s / 60}m ${s % 60}s"
            s < 86_400 -> {
                val minutes = (s % 3600) / 60
                if (minutes == 0L) "${s / 3600}h" else "${s / 3600}h ${minutes}m"
            }
            else -> {
                val hours = (s % 86_400) / 3600
                if (hours == 0L) "${s / 86_400}d" else "${s / 86_400}d ${hours}h"
            }
        }
    }

    /** Seconds from `from` to `to` (an ISO time), or nil when either is not one. */
    private fun between(from: String?, to: String?): Double? {
        val start = RelativeTime.parse(from) ?: return null
        val end = RelativeTime.parse(to) ?: return null
        return maxOf(0.0, RelativeTime.seconds(start, end))
    }
    private fun between(from: String?, now: Instant): Double? {
        val start = RelativeTime.parse(from) ?: return null
        return maxOf(0.0, RelativeTime.seconds(start, now))
    }

    private fun join(parts: List<String?>) = parts.filter { !it.isNullOrEmpty() }.joinToString(" · ")

    /** A failure's first line: what a row has room for. */
    private fun firstLine(text: String?): String? {
        val line = text.orEmpty().split("\n").firstOrNull()?.trim().orEmpty()
        return line.ifEmpty { null }
    }

    /** The run's row (mock 35 ④) — the web's `wikiRunRow`. */
    fun row(job: WikiJob, now: Instant): WikiRunRow {
        val kind = WikiRunsCopy.kind(job.kind)
        fun ago(iso: String?) = WikiHealthLogic.ago(iso, now)
        return when (job.state) {
            "queued" -> {
                val retry = if (job.attempts > 0) job.nextAttemptAt?.let { between(now.toString(), it) } else null
                val place = if (retry != null && retry > 0) WikiRunsCopy.retryingIn(duration(retry))
                    else job.ahead?.let { if (it == 0) WikiRunsCopy.nextInLine else WikiRunsCopy.runsAhead(it) }
                WikiRunRow(kind, WikiRunRow.Mark.WARN, WikiRunRow.Tone.WARN, WikiRunsCopy.queued,
                    join(listOf(place, WikiRunsCopy.waited(duration(between(job.createdAt, now) ?: 0.0)))), ago(job.createdAt))
            }
            "running" -> {
                val progress = job.progress?.let { p -> if (p.done != null && p.total != null) "${p.step?.let { "$it " } ?: ""}${p.done} of ${p.total}" else null }
                    ?: if (job.calls.total > 0) WikiRunsCopy.callsEnded(job.calls.succeeded + job.calls.failed + job.calls.cancelled, job.calls.total)
                    else WikiRunsCopy.starting
                val next = job.nextCall?.let { WikiRunsCopy.nextCall(it.ahead, duration(between(it.enqueuedAt, now) ?: 0.0)) }
                WikiRunRow(kind, WikiRunRow.Mark.SPIN, WikiRunRow.Tone.PLAIN, WikiRunsCopy.running, join(listOf(progress, next)),
                    WikiRunsCopy.started(ago(job.startedAt ?: job.createdAt)))
            }
            "waiting" -> WikiRunRow(kind, WikiRunRow.Mark.WARN, WikiRunRow.Tone.WARN,
                if (job.waitingFor == "model") WikiRunsCopy.waitingModel else WikiRunsCopy.waitingRunner,
                duration(between(job.updatedAt, now) ?: 0.0), WikiRunsCopy.started(ago(job.startedAt ?: job.createdAt)))
            "succeeded" -> {
                val tokens = job.calls.inputTokens + job.calls.outputTokens
                val took = between(job.startedAt ?: job.createdAt, job.endedAt)
                WikiRunRow(kind, WikiRunRow.Mark.OK, WikiRunRow.Tone.PLAIN, WikiRunsCopy.done,
                    join(listOf(WikiRunsCopy.calls(job.calls.total), if (tokens > 0) WikiRunsCopy.tokens(tokens) else null,
                        took?.let { WikiRunsCopy.took(duration(it)) })), ago(job.endedAt ?: job.updatedAt))
            }
            "failed" -> WikiRunRow(kind, WikiRunRow.Mark.ERROR, WikiRunRow.Tone.ERROR, WikiRunsCopy.failed,
                join(listOf(firstLine(job.error) ?: WikiRunsCopy.noResult, if (job.calls.total > 0) WikiRunsCopy.calls(job.calls.total) else null)),
                ago(job.endedAt ?: job.updatedAt))
            else -> WikiRunRow(kind, WikiRunRow.Mark.NONE, WikiRunRow.Tone.MUTED, WikiRunsCopy.cancelled, "",
                ago(job.endedAt ?: job.updatedAt))
        }
    }

    /** The line under a run's call log — the web's `wikiRunFootText`. */
    fun foot(job: WikiJob): String {
        val over = job.state == "succeeded" || job.state == "failed" || job.state == "cancelled"
        var text = WikiRunsCopy.foot(job.calls.total, job.calls.inputTokens, job.calls.outputTokens)
        if (!over) text += " ${WikiRunsCopy.soFar}"
        if (job.requests.isNotEmpty() && job.requests.size < job.calls.total) text += " · ${WikiRunsCopy.showingLast(job.requests.size)}"
        return text
    }

    private val uuid = Regex("^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")

    /** A unit as the log names it: a uuid cut to its last eight characters (`wikiCallUnit`) — the end, not the start:
     * op ids are time-ordered (v7), so every id made the same minute shares its first eight. */
    fun unit(unit: String) = if (uuid.matches(unit)) unit.takeLast(8) else unit

    /** One row of a run's call log — the web's `wikiCallRow`. */
    fun callRow(call: WikiJobCall, now: Instant): WikiCallRow {
        val waitedFor = if (call.state == "queued") between(call.enqueuedAt, now) else between(call.enqueuedAt, call.startedAt)
        val ranFor = if (call.state == "running") between(call.startedAt, now)
            else if (call.startedAt != null && call.endedAt != null) between(call.startedAt, call.endedAt) else null
        val waited = waitedFor?.let { duration(it) } ?: WikiRunsCopy.noValue
        val ran = if (call.state == "queued" || ranFor == null) WikiRunsCopy.noValue else duration(ranFor)
        val tokens = if (call.inputTokens != null && call.outputTokens != null) WikiRunsCopy.callTokens(call.inputTokens, call.outputTokens)
            else WikiRunsCopy.noValue
        val state: String
        val tone: WikiCallRow.Tone
        when (call.state) {
            "queued" -> { state = call.ahead?.let { WikiRunsCopy.callAhead(it) } ?: WikiRunsCopy.callQueued; tone = WikiCallRow.Tone.WARN }
            "running" -> { state = WikiRunsCopy.callRunning; tone = WikiCallRow.Tone.RUN }
            "succeeded" -> { state = WikiRunsCopy.callDone; tone = WikiCallRow.Tone.OK }
            "failed" -> { state = WikiRunsCopy.callFailed; tone = WikiCallRow.Tone.ERROR }
            else -> { state = WikiRunsCopy.callCancelled; tone = WikiCallRow.Tone.MUTED }
        }
        val line = join(listOf(
            if (waited != WikiRunsCopy.noValue) WikiRunsCopy.waited(waited) else null,
            if (ran != WikiRunsCopy.noValue) WikiRunsCopy.ran(ran) else null,
            if (tokens != WikiRunsCopy.noValue) "$tokens tokens" else null))
        return WikiCallRow("${call.step} · ${unit(call.unit)}", state, if (call.attempts > 0) WikiRunsCopy.retries(call.attempts) else null,
            tone, waited, ran, tokens, line, if (call.state == "succeeded" || call.state == "cancelled") null else firstLine(call.error))
    }

    /** Whether the Runs band is drawn: the server runs this account's wiki, or ran something for the space. */
    fun shown(serverExecutes: Boolean, jobs: List<WikiJob>?) = serverExecutes || !jobs.isNullOrEmpty()
}
