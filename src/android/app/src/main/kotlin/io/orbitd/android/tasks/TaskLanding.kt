package io.orbitd.android.tasks

import io.orbitd.android.core.cards.obj
import io.orbitd.android.core.cards.text
import io.orbitd.android.navigation.Destination
import io.orbitd.android.navigation.OrbitRoute
import io.orbitd.android.projects.ProjectPage
import io.orbitd.android.projects.ProjectTime
import io.orbitd.android.taskprojects.SharePanelCopy
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.math.max
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull

// A task's newest LAND_TASK, as the server's read model describes it (contract §2.7a) — on the
// task's page in the web's `LandTaskStatus` and iOS `TaskLandingLogic` words. DONE is the task's
// status; this is its landing. The two are drawn apart because a DONE task whose work is still
// waiting, running or stopped is not on its branch yet. Read-only by design: no retry, merge or
// release door lives here; the one press is the way into its landing session (A-1).

/** The section's words, every one of them already declared by OrbitKit's `TaskLanding.swift` (or the
 * `LandingSessionPage.swift` that names the entrance), held there by `TaskCopyParityTest`. */
object TaskLandingCopy {
    const val landingSection = "Landing"

    /** What each state of a landing attempt is called, wherever one is shown (web `LANDING_LABELS`). */
    val labels = mapOf(
        "QUEUED" to "Waiting to land",
        "RUNNING" to "Landing",
        "LANDED" to "Landed",
        "ALREADY_LANDED" to "Already landed",
        "NOTHING_TO_LAND" to "Nothing to land",
        "READY" to "Ready to merge",
        "CONFLICT" to "Landing conflict",
        "CHECK_FAILED" to "Landing checks failed",
        "ERROR" to "Landing error",
        "CANCELLED" to "Landing cancelled",
        "SUPERSEDED" to "Landing superseded",
    )

    /** The badge's ink per state: amber, blue, green, muted or red. */
    val tones = mapOf(
        "QUEUED" to "amber",
        "RUNNING" to "blue",
        "LANDED" to "green",
        "ALREADY_LANDED" to "green",
        "NOTHING_TO_LAND" to "muted",
        "READY" to "amber",
        "CONFLICT" to "red",
        "CHECK_FAILED" to "red",
        "ERROR" to "red",
        "CANCELLED" to "muted",
        "SUPERSEDED" to "muted",
    )

    const val generation = "generation"
    const val stoppedWhile = "stopped while"
    const val onPrefix = "On "
    const val waitingNotQueued = "Waiting to land: the landing has not been queued yet"

    /** The two receipt sentences: a receipt says where the work IS, and no attempt after it takes that back. */
    fun receiptOn(main: String): String = "Its work is on $main by an existing receipt."
    const val receiptOnBranch = "Its work is on the project branch by an existing receipt."

    /** The fact rows under the badge, in the web's order. */
    const val targetLabel = "Target"
    const val queueWaitLabel = "Queue wait"
    const val queuedLabel = "Queued"
    const val startedLabel = "Started"
    const val heartbeatLabel = "Heartbeat"
    const val finishedLabel = "Finished"

    /** The one press in the section: the way into the landing session this generation belongs to. */
    const val openLanding = "Open landing"
}

/** One task's newest LAND_TASK generation, as the read model's own row says it (§2.7a). */
internal data class LandTaskView(
    val state: String,
    val jobId: String,
    val generation: String? = null,
    val phase: String? = null,
    val heartbeatAt: String? = null,
    val targetRef: String? = null,
    val waitMs: Long? = null,
    val queuedAt: String? = null,
    val startedAt: String? = null,
    val finishedAt: String? = null,
    /** `blockingReason.summary`: why the attempt waits or where it stopped, in the server's words. */
    val blockingReason: String? = null,
    /** The landing session of this generation (§2.9 LS6); absent on a server that predates the field. */
    val landingSessionId: String? = null,
) {
    companion object {
        fun of(integration: JsonObject): LandTaskView? {
            val job = integration.obj("landTask") ?: return null
            val state = job.text("state") ?: return null
            return LandTaskView(
                state = state,
                jobId = job.text("jobId").orEmpty(),
                generation = job.text("generation"),
                phase = job.text("phase"),
                heartbeatAt = job.text("heartbeatAt"),
                targetRef = job.text("targetRef"),
                waitMs = (job["waitMs"] as? JsonPrimitive)?.longOrNull,
                queuedAt = job.text("queuedAt"),
                startedAt = job.text("startedAt"),
                finishedAt = job.text("finishedAt"),
                blockingReason = job.obj("blockingReason")?.text("summary"),
                landingSessionId = job.text("landingSessionId")?.takeIf { it.isNotEmpty() },
            )
        }
    }
}

/** A task's own integration read (§2.7a): where its work stands between DONE and main. */
internal data class TaskIntegrationView(val state: String, val landTask: LandTaskView?) {
    companion object {
        /** Null on a server that predates the unified read — and then the page draws no Landing section. */
        fun of(task: JsonObject?): TaskIntegrationView? = task?.obj("integration")?.let { view ->
            TaskIntegrationView(view.text("state") ?: "NOT_APPLICABLE", LandTaskView.of(view))
        }
    }
}

/** One task's Landing section, as its page draws it. */
internal data class TaskLandingStatus(
    val badge: Badge?,
    val generation: String?,
    /** `checking`, or `stopped while checking` for an attempt that stopped at a step. */
    val step: String?,
    val noReport: String?,
    val reason: String?,
    val receipt: String?,
    val facts: List<Fact>,
    /** The landing session this task's newest generation belongs to, which `Open landing ›` opens. */
    val landingSessionId: String?,
) {
    data class Badge(val label: String, val tone: String)
    data class Fact(val label: String, val value: String)
}

internal object TaskLandingLogic {
    /** The stops a page reads a step word for. */
    private val stopped = setOf("CONFLICT", "CHECK_FAILED", "ERROR")

    /** The badge a task's page puts beside its status: the newest attempt when there is one, otherwise
     * where the receipts say the work is. Null when the task has no landing to speak of. */
    fun badge(integration: TaskIntegrationView, main: String = "main"): TaskLandingStatus.Badge? {
        val job = integration.landTask
        if (job != null) return TaskLandingStatus.Badge(
            TaskLandingCopy.labels[job.state] ?: job.state,
            TaskLandingCopy.tones[job.state] ?: "muted")
        return when (integration.state) {
            // Done code work on a line whose landing has not been queued yet (§2.3 J-T1d).
            "QUEUED" -> TaskLandingStatus.Badge(TaskLandingCopy.labels.getValue("QUEUED"), TaskLandingCopy.tones.getValue("QUEUED"))
            "ON_INTEGRATION_LINE" -> TaskLandingStatus.Badge(TaskLandingCopy.labels.getValue("LANDED"), TaskLandingCopy.tones.getValue("LANDED"))
            "ON_UPSTREAM" -> TaskLandingStatus.Badge("${TaskLandingCopy.onPrefix}$main", "green")
            else -> null
        }
    }

    /** The section, or null for a task with no landing to speak of. */
    fun status(integration: TaskIntegrationView?, now: Instant = Instant.now(),
        zone: ZoneId = ZoneId.systemDefault(), main: String = "main"): TaskLandingStatus? {
        if (integration == null) return null
        val badge = badge(integration, main) ?: return null
        val job = integration.landTask
        val step = job?.phase?.takeIf { job.state == "RUNNING" || job.state in stopped }?.let { ProjectPage.phaseWords(main)[it] }
        val receipt = integration.state == "ON_INTEGRATION_LINE" || integration.state == "ON_UPSTREAM"
        // A claimed job whose runner has gone quiet: no report at all, or none since the claim lease
        // the project page uses. A silent runner is neither a stop nor a timeout — the job's own
        // verdict is the only thing that ever says "timed out", and it arrives as the reason below.
        val heartbeat = job?.heartbeatAt?.let(ProjectTime::parse)
        val reported = heartbeat != null
        val minutes = heartbeat?.let { max(0L, (now.toEpochMilli() - it.toEpochMilli()) / 60_000).toInt() } ?: 0
        val silent = job?.state == "RUNNING" && (heartbeat == null || now.toEpochMilli() - heartbeat.toEpochMilli() > CLAIM_STALE_MS)
        val noReport = when {
            !silent -> null
            reported -> ProjectPage.landingNoReportFor(minutes)
            else -> ProjectPage.landingNoReportYet
        }
        val receiptLine = if (receipt && job != null && job.state != "LANDED" && job.state != "ALREADY_LANDED") {
            if (integration.state == "ON_UPSTREAM") TaskLandingCopy.receiptOn(main) else TaskLandingCopy.receiptOnBranch
        } else null
        // A task on a line whose landing has not been queued yet says so, as the web does.
        val reason = job?.blockingReason
            ?: if (job == null && integration.state == "QUEUED") TaskLandingCopy.waitingNotQueued else null
        return TaskLandingStatus(
            badge = badge,
            generation = job?.generation,
            step = step?.let { word -> if (job?.state == "RUNNING") word else "${TaskLandingCopy.stoppedWhile} $word" },
            noReport = noReport,
            reason = reason,
            receipt = receiptLine,
            facts = facts(job, zone),
            landingSessionId = job?.landingSessionId,
        )
    }

    /** The six rows under the badge, from the job row's own columns. */
    fun facts(job: LandTaskView?, zone: ZoneId = ZoneId.systemDefault()): List<TaskLandingStatus.Fact> {
        if (job == null) return emptyList()
        fun time(iso: String?) = ProjectTime.parse(iso)?.let { instant.withZone(zone).format(it) } ?: "—"
        val wait = job.waitMs?.let { if (it < 1_000) "0s" else SharePanelCopy.span(it / 1_000.0) } ?: "0s"
        return listOf(
            TaskLandingStatus.Fact(TaskLandingCopy.targetLabel, branch(job.targetRef)),
            TaskLandingStatus.Fact(TaskLandingCopy.queueWaitLabel, wait),
            TaskLandingStatus.Fact(TaskLandingCopy.queuedLabel, time(job.queuedAt)),
            TaskLandingStatus.Fact(TaskLandingCopy.startedLabel, time(job.startedAt)),
            TaskLandingStatus.Fact(TaskLandingCopy.heartbeatLabel, time(job.heartbeatAt)),
            TaskLandingStatus.Fact(TaskLandingCopy.finishedLabel, time(job.finishedAt)),
        )
    }

    /** `refs/heads/project/x` as a branch is spoken of. */
    fun branch(ref: String?): String = ref.orEmpty().replace("refs/heads/", "")

    /** §2.7a's cadence for the task page: a landing that RUNS is read every 4 s, a queued one every
     * 15 s, and a settled one not at all. Milliseconds for the page's poll loop. */
    fun refetchInterval(integration: TaskIntegrationView?): Long? = when (integration?.landTask?.state ?: integration?.state) {
        "RUNNING" -> 4_000
        "QUEUED" -> 15_000
        else -> null
    }

    /** Where `Open landing ›` goes: the landing session's own page, or nowhere on a server that named none. */
    fun route(status: TaskLandingStatus): OrbitRoute? = status.landingSessionId?.let { OrbitRoute(Destination.SESSION, it) }

    /** The claim lease the project page reads a heartbeat against when the server sends no verdict. */
    private const val CLAIM_STALE_MS = 10 * 60_000L

    private val instant = DateTimeFormatter.ofPattern("MMM d, h:mm:ss a", Locale.US)
}
