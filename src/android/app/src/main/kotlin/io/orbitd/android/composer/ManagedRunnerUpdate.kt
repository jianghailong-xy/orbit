package io.orbitd.android.composer

import io.orbitd.android.core.net.ApiError
import io.orbitd.android.management.RunnerCopy
import io.orbitd.android.management.RunnerPage
import io.orbitd.android.management.isoMs
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

/**
 * Orbit Cloud's Update card, confirmation and version line (docs/managed-runner-update-now-design.md, board 5), driven by the managed
 * status's `update` instead of a self-managed runner's `selfUpdate`. Its words are the web's managed* sentences (runnerCopy.ts); the
 * rest are RunnerCopy's, shared with the self-managed card. Android's reading of OrbitKit's `ManagedRunnerUpdateLogic`.
 */
internal object ManagedRunnerCopy {
    fun buildLine(sha: String) = "Build $sha"
    fun buildLineBuilt(sha: String, built: String) = "Build $sha · $built"
    fun buildNamed(name: String) = "the $name build"
    fun availableTitle(build: String) = "$build is available"
    const val ROW_TITLE = "A new build is available"
    const val AVAILABLE_BODY = "It moves the next time this runner is idle. Update Now restarts it on the new build now — usually under a minute. " +
        "Your files, sign-ins and sessions stay."
    fun restartingTitle(build: String) = "Restarting on $build…"
    fun updatedTitle(build: String) = "Updated to $build"
    const val TAG_UPDATED = "Updated"
    fun nowBodyNone(build: String) = "No turn is running. It restarts on $build — usually under a minute. Your files, sign-ins and sessions stay."
    fun nowBodyOne(build: String) = "It stops this turn and restarts on $build — usually under a minute. It then continues where it stopped, " +
        "with a note that the update interrupted it."
    fun nowBodyMany(build: String) = "It stops these turns and restarts on $build — usually under a minute. Each one then continues where it " +
        "stopped, with a note that the update interrupted it."
    fun nowJobs(jobs: Int, noun: String) = "$jobs $noun in these sessions stop, and so do the services they started. Waiting work starts once it is back."
    const val NOW_SERVICES = "Services started in these sessions stop. Waiting work starts once it is back."
    const val UPDATE_NOW = "Update Now…"
    fun nowTitle(runner: String) = "Update $runner now?"
    const val NOW_FAILED = "Couldn’t update the runner"
    fun nowConfirm(turns: Int) = when (turns) {
        0 -> "Update Now"
        1 -> "Interrupt 1 Turn and Update"
        else -> "Interrupt $turns Turns and Update"
    }
}

/** One build of the managed runner image: its source commit, and when it was built, if known. */
/** `version` is the release it was published for (`0.1.261-beta.83`); null for an image built from a checkout. */
data class ManagedBuild(val sha: String, val builtAt: String? = null, val version: String? = null)

/** The runner runs an older build than the current image's. `available`: READY on the older build; `updating`: on its way to the next container. */
data class ManagedUpdate(val running: ManagedBuild, val current: ManagedBuild, val phase: String, val waitsForIdle: Boolean = false)

/** A turn running on the managed runner, as a busy Update Now's 409 lists it. */
data class ManagedBusyTurn(val sessionId: String, val title: String?, val startedAt: String?)

/** The 409 `MANAGED_RUNNER_BUSY` body: what updating now would stop. */
data class ManagedBusy(val turns: List<ManagedBusyTurn>, val backgroundJobs: Int)

/** An Update Now pressed and not yet seen through. */
data class ManagedPendingUpdate(val at: Long, val interruptedTurns: Int, val to: ManagedBuild)

/** The build an Update Now finished on, shown for a day. */
data class ManagedUpdated(val build: ManagedBuild, val at: Long, val tookSeconds: Int? = null, val interruptedTurns: Int = 0)

/** The build the managed runner is running, as the last status read said (null when it runs the current one): its date is what the version line adds. */
object ManagedRunnerRunningBuild {
    @Volatile var build: ManagedBuild? = null
}

internal object ManagedRunnerUpdateLogic {
    const val POST_PATH = "managed-runner/update-now"
    private const val BUSY_CODE = "MANAGED_RUNNER_BUSY"

    fun shortSha(sha: String) = sha.take(7)

    private fun dayLabel(iso: String?, zone: ZoneId): String? = isoMs(iso)?.let {
        DateTimeFormatter.ofPattern("MMM d", Locale.US).withZone(zone).format(Instant.ofEpochMilli(it))
    }

    /** The version line: `Build 95884b1 · Nov 16`, or `Build 95884b1` when no build date is known. */
    fun buildLine(build: ManagedBuild, zone: ZoneId = ZoneId.systemDefault()): String =
        dayLabel(build.builtAt, zone)?.let { ManagedRunnerCopy.buildLineBuilt(shortSha(build.sha), it) } ?: ManagedRunnerCopy.buildLine(shortSha(build.sha))

    /** How a card names a build: its release version (`0.1.261-beta.83`), else `the Nov 18 build`, or `the 1a2b3c4 build` when it has no date. */
    fun buildName(build: ManagedBuild, zone: ZoneId = ZoneId.systemDefault()): String =
        build.version?.takeIf { it.isNotEmpty() } ?: ManagedRunnerCopy.buildNamed(dayLabel(build.builtAt, zone) ?: shortSha(build.sha))

    /** The build a runner's `managed-<sha>` version names, with the date the status knows for it. */
    fun runningBuild(version: String?, known: ManagedBuild?): ManagedBuild? {
        val trimmed = version?.trim().orEmpty()
        if (!trimmed.startsWith("managed-")) return null
        val sha = trimmed.removePrefix("managed-").takeIf { it.isNotEmpty() } ?: return null
        if (known != null && (known.sha.startsWith(sha) || sha.startsWith(known.sha))) return known
        return ManagedBuild(sha)
    }

    /** Whether the machine row draws the update dot: an older build is running and nothing is moving it yet. */
    fun showsDot(status: ManagedRunner.Status?) = status?.update?.phase == "available"

    /** The card's phases: `available`, `updating` (Restarting) and `updated`. */
    data class Card(val phase: String, val warn: Boolean, val title: String, val tag: String, val body: String,
                    /** Update Now… is drawn: an owner's `available` card only. */
                    val canUpdateNow: Boolean, val build: ManagedBuild)

    private fun capitalized(text: String) = text.replaceFirstChar { it.uppercase() }

    /** The card the status calls for; null when the runner is current (no `update`) and no update finished in the last day. */
    fun card(status: ManagedRunner.Status?, updated: ManagedUpdated? = null, isOwner: Boolean = true, pendingTurns: Int? = null,
             nowMs: Long = System.currentTimeMillis(), zone: ZoneId = ZoneId.systemDefault()): Card? {
        val update = status?.update
        if (update != null) {
            val build = buildName(update.current, zone)
            return when (update.phase) {
                "available" -> Card("available", false, ManagedRunnerCopy.availableTitle(capitalized(build)), RunnerCopy.UPDATE_TAG_AVAILABLE,
                    ManagedRunnerCopy.AVAILABLE_BODY, isOwner, update.current)
                "updating" -> Card("updating", true, ManagedRunnerCopy.restartingTitle(build), RunnerCopy.UPDATE_TAG_RESTARTING,
                    pendingTurns?.takeIf { it > 0 }?.let(RunnerCopy::updateRestartingBodyInterrupted) ?: RunnerCopy.UPDATE_RESTARTING_BODY,
                    false, update.current)
                else -> null
            }
        }
        if (updated == null || nowMs - updated.at > RunnerCopy.UPDATE_TAG_UPDATED_HOURS * 3_600_000L || updated.at - nowMs > 60_000) return null
        return Card("updated", false, ManagedRunnerCopy.updatedTitle(buildName(updated.build, zone)), ManagedRunnerCopy.TAG_UPDATED,
            RunnerCopy.updateUpdatedBody(updated.tookSeconds?.let(RunnerCopy::updateTook), updated.interruptedTurns), false, updated.build)
    }

    /** What follows one status read after another: an update that was on its way and is gone with the runner READY has finished. */
    fun observe(previous: ManagedRunner.Status?, next: ManagedRunner.Status?, updated: ManagedUpdated?, pending: ManagedPendingUpdate?,
                nowMs: Long): ManagedUpdated? {
        if (next == null) return updated
        if (next.update != null) return null
        val moved = previous?.update
        if (moved != null && moved.phase == "updating" && next.managementState == "READY") {
            return ManagedUpdated(pending?.to ?: moved.current, nowMs, pending?.let { maxOf(1, ((nowMs - it.at) / 1000.0).let(Math::round).toInt()) },
                pending?.interruptedTurns ?: 0)
        }
        return updated
    }

    /** The confirmation for a busy runner: the turns and background jobs the 409 named. */
    data class Confirmation(val title: String, val body: String, val turns: List<String>, val jobsNote: String, val confirm: String, val build: ManagedBuild)

    fun confirmation(busy: ManagedBusy, build: ManagedBuild, nowMs: Long, zone: ZoneId = ZoneId.systemDefault()): Confirmation {
        val name = buildName(build, zone)
        val turns = busy.turns.map { turn ->
            val shown = turn.title?.trim()?.takeIf { it.isNotEmpty() } ?: RunnerCopy.UPDATE_UNTITLED_TURN
            val started = isoMs(turn.startedAt) ?: return@map shown
            shown + RunnerCopy.SEP + RunnerCopy.updateTurnRunning(RunnerPage.updateWaited(maxOf(0L, (nowMs - started) / 60_000).toInt()))
        }
        val count = busy.turns.size
        return Confirmation(
            ManagedRunnerCopy.nowTitle(RunnerCopy.MANAGED_RUNNER_LABEL),
            when (count) { 0 -> ManagedRunnerCopy.nowBodyNone(name); 1 -> ManagedRunnerCopy.nowBodyOne(name); else -> ManagedRunnerCopy.nowBodyMany(name) },
            turns,
            if (busy.backgroundJobs > 0) ManagedRunnerCopy.nowJobs(busy.backgroundJobs, if (busy.backgroundJobs == 1) "background job" else "background jobs")
            else ManagedRunnerCopy.NOW_SERVICES,
            ManagedRunnerCopy.nowConfirm(count), build)
    }

    /** The busy answer inside a refused Update Now, or null for any other failure. */
    fun busy(error: Throwable): ManagedBusy? {
        val api = error as? ApiError ?: return null
        val body = api.body as? JsonObject ?: return null
        if (api.status != 409 || (body["code"] as? JsonPrimitive)?.contentOrNull != BUSY_CODE) return null
        val turns = (body["turns"] as? JsonArray).orEmpty().filterIsInstance<JsonObject>().map {
            fun str(name: String) = (it[name] as? JsonPrimitive)?.takeIf { p -> p.isString }?.contentOrNull
            ManagedBusyTurn(str("sessionId").orEmpty(), str("title"), str("startedAt"))
        }
        return ManagedBusy(turns, (body["backgroundJobs"] as? JsonPrimitive)?.intOrNull ?: 0)
    }

    /** `status.update` from the body of GET /managed-runner. */
    fun update(body: JsonObject): ManagedUpdate? {
        val o = body["update"] as? JsonObject ?: return null
        fun build(name: String): ManagedBuild? {
            val b = o[name] as? JsonObject ?: return null
            val sha = (b["sha"] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull ?: return null
            return ManagedBuild(
                sha,
                (b["builtAt"] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull,
                (b["version"] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull,
            )
        }
        return ManagedUpdate(build("running") ?: return null, build("current") ?: return null,
            (o["phase"] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull ?: return null,
            (o["waitsForIdle"] as? JsonPrimitive)?.booleanOrNull == true)
    }
}
