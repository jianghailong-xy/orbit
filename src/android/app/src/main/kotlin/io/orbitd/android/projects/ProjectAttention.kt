package io.orbitd.android.projects

import io.orbitd.android.core.cards.*
import io.orbitd.android.directory.DirectorySession
import io.orbitd.android.directory.SessionProjectGrouping
import io.orbitd.android.directory.isRunning
import kotlinx.serialization.json.JsonObject
import java.time.Instant

/** OrbitKit `ProjectAttentionSection`: the six lanes, in next-actor order. */
enum class ProjectLane(val title: String, val note: String) {
    ATTENTION("Needs attention", "Owner-only decisions, stale coordination, non-convergence, quiet work, or closure · reason/severity first, then oldest signal"),
    RUNNING("Running", "Fresh work in flight · newest task activity first"),
    READY("Ready", "Can start now, nothing running · oldest task activity first"),
    WAITING("Waiting", "Dependency-blocked or verification-gated work remains · oldest task activity first"),
    DEFINITION("Needs definition", "No tasks filed yet · title A–Z"),
    COMPLETED("Completed", "Closed projects · newest task activity first · folded by default");
    val defaultCollapsed get() = this == COMPLETED
}

/** OrbitKit `ProjectAttentionReason`; `rank` is the one tier the four owner items and a coordinator's request to start the project
 * or to record it done share. DONE_REQUEST is that request ("Needs you · Ready to close"); READY_TO_CLOSE a project whose tasks all
 * settled and that nobody asked about. */
enum class AttentionReason(val rank: Int, val ownerItem: Boolean = false) {
    APPROVE_MERGE_TO_MAIN(1, true), COORDINATOR_QUESTION(1, true), ESCALATED_TO_YOU(1, true), FUSE_PAUSED(1, true),
    READY_TO_START(1), DONE_REQUEST(1), NEEDS_USER(2), AUTO_REMEDIATION(3), NO_ACTIVITY_RUNNING(4), NO_ACTIVITY_READY(5),
    READY_TO_CLOSE(6), COORDINATOR_HANDLING(7);
    val needsYou get() = ownerItem || this == READY_TO_START || this == DONE_REQUEST
}

/** The chip beside a row's title: `warning` is something a person should look at, else the brand tone. */
data class AttentionChip(val warning: Boolean, val text: String)
data class IntegrationChip(val text: String, val branch: Boolean)

/** OrbitKit `ProjectDrawerMark`: how a project reads as one line of the navigation drawer. */
sealed interface DrawerMark {
    /** Something is waiting on the reader, with how many things wait ([ProjectAttention.needsYouItemCount]): the row's amber count. */
    data class NeedsYou(val count: Int) : DrawerMark
    /** Tasks are running, its coordinator is working, or a landing is in flight. */
    data object Running : DrawerMark
    data object Idle : DrawerMark
}

/** OrbitKit `ProjectCoordinatorPulse`: what the live session list says about a project's coordinator conversation — whether it draws
 * the list's running spinner, and its newest turn, activity the project's own task stamps do not record. The drawer's project rows
 * are fetched, but a coordinator's turns arrive with the session list: read beside the row, they make a project whose coordinator is
 * working read as running, and sort where the work is, as soon as the session list shows it rather than at the next fetch. */
data class CoordinatorPulse(val working: Boolean, val lastTurnAt: String?)

/** A port of OrbitKit `ProjectAttention` over the `GET /projects` rows: a row first answers whether
 * something requires a person, then whether work is running; raw `ready` counts never rank projects. */
object ProjectAttention {
    private const val MINUTE = 60.0
    private const val HOUR = 3_600.0
    private const val DAY = 86_400.0
    private val ownerItemOrder = listOf("PROMOTION_APPROVAL", "COORDINATOR_QUESTION", "ESCALATED", "FUSE_PAUSED")
    const val readyToStartSays = "Needs you · ${StartProjectCopy.readyToStart}"
    /** The sixth, in the words the coordinator's session row and the project page say it: its coordinator asked to record it done. */
    const val readyToCloseSays = "Needs you · ${ProjectDone.readyToClose}"

    private fun at(iso: String?): Double = ProjectTime.parse(iso)?.let { it.toEpochMilli() / 1000.0 } ?: Double.NEGATIVE_INFINITY
    private fun seconds(now: Instant) = now.toEpochMilli() / 1000.0
    private fun byInstantDesc(left: String?, right: String?): Int {
        val l = at(left); val r = at(right)
        return if (l == r) 0 else if (r > l) 1 else -1
    }
    /** Oldest real instant first; missing or invalid instants are unknown and sort last. */
    private fun byInstantAsc(left: String?, right: String?): Int {
        val l = at(left); val r = at(right)
        return when { l == r -> 0; l == Double.NEGATIVE_INFINITY -> 1; r == Double.NEGATIVE_INFINITY -> -1; l < r -> -1; else -> 1 }
    }
    private fun byId(a: JsonObject, b: JsonObject) = a.text("id").orEmpty().compareTo(b.text("id").orEmpty()).coerceIn(-1, 1)

    /** Whole quiet days, or null when the timestamp is missing, invalid, future, or still fresh. */
    private fun quietDays(lastActivityAt: String?, now: Instant): Int? {
        val at = at(lastActivityAt)
        if (at == Double.NEGATIVE_INFINITY) return null
        val quiet = seconds(now) - at
        return if (quiet < DAY) null else (quiet / DAY).toInt()
    }
    private fun elapsedDayLabel(iso: String?, now: Instant): String? {
        val at = at(iso)
        if (at == Double.NEGATIVE_INFINITY || at > seconds(now)) return null
        val days = ((seconds(now) - at) / DAY).toInt()
        return if (days == 0) "<1d" else "${days}d"
    }
    internal fun elapsedLabel(iso: String?, now: Instant): String? {
        val at = at(iso)
        if (at == Double.NEGATIVE_INFINITY || at > seconds(now)) return null
        val waited = seconds(now) - at
        return when {
            waited < MINUTE -> "<1m"
            waited < HOUR -> "${(waited / MINUTE).toInt()}m"
            waited < DAY -> "${(waited / HOUR).toInt()}h"
            else -> "${(waited / DAY).toInt()}d"
        }
    }

    private fun buckets(project: JsonObject) = project.obj("buckets") ?: JsonObject(emptyMap())
    private fun count(project: JsonObject, key: String) = buckets(project).number(key) ?: 0
    fun taskCount(project: JsonObject) = project.obj("_count")?.number("tasks") ?: 0
    fun open(project: JsonObject) = project.text("status") == "OPEN"

    /** Current servers report FAILED explicitly; the remainder is derived only for an older server. */
    fun failedTaskCount(project: JsonObject): Int = buckets(project).number("failed")
        ?: maxOf(0, taskCount(project) - listOf("running", "ready", "blocked", "awaitingVerification", "done", "cancelled").sumOf { count(project, it) })

    private fun autoRemediationBlockers(project: JsonObject) =
        (project.obj("attention")?.number("coordinatorBlockers") ?: 0) + (project.obj("attention")?.number("systemBlockers") ?: 0)
    private fun platformWorking(project: JsonObject) =
        (project.obj("integration")?.number("activeJobCount") ?: 0) > 0 || project.obj("coordinatorActivity")?.flag("working") == true

    /** The owner item the row leads with: the longest waiting, a fixed kind order settling a tie. */
    fun leadOwnerItem(project: JsonObject): JsonObject? {
        val items = project.obj("attention")?.objects("ownerItems").orEmpty()
        var lead: JsonObject? = null
        for (kind in ownerItemOrder) {
            val item = items.firstOrNull { it.text("kind") == kind } ?: continue
            if (lead == null || byInstantAsc(item.text("oldestWaitingSince"), lead.text("oldestWaitingSince")) < 0) lead = item
        }
        return lead
    }
    private fun startRequest(project: JsonObject) = project.obj("attention")?.obj("startRequest")?.takeIf { it.text("waitingSince") != null }
    /** The coordinator's open request to record this project done; the server sends it only while the project is OPEN. */
    private fun doneRequest(project: JsonObject) = project.obj("attention")?.obj("doneRequest")?.takeIf { it.text("waitingSince") != null }
    /** The start request leads when it has waited longest — the four first on a tie — unless a request to close waited longer still. */
    private fun startRequestLeads(project: JsonObject): Boolean {
        val start = startRequest(project) ?: return false
        doneRequest(project)?.let { done -> if (byInstantAsc(done.text("waitingSince"), start.text("waitingSince")) < 0) return false }
        val lead = leadOwnerItem(project) ?: return true
        return byInstantAsc(start.text("waitingSince"), lead.text("oldestWaitingSince")) < 0
    }
    /** The request to record the project done leads when it has waited longest — after the four and after a start on a tie. */
    private fun doneRequestLeads(project: JsonObject): Boolean {
        val done = doneRequest(project) ?: return false
        startRequest(project)?.let { start -> if (byInstantAsc(start.text("waitingSince"), done.text("waitingSince")) <= 0) return false }
        val lead = leadOwnerItem(project) ?: return true
        return byInstantAsc(done.text("waitingSince"), lead.text("oldestWaitingSince")) < 0
    }
    private fun needsYouSince(project: JsonObject) = when {
        startRequestLeads(project) -> startRequest(project)?.text("waitingSince")
        doneRequestLeads(project) -> doneRequest(project)?.text("waitingSince")
        else -> leadOwnerItem(project)?.text("oldestWaitingSince")
    }
    private fun reasonFor(kind: String?) = when (kind) {
        "PROMOTION_APPROVAL" -> AttentionReason.APPROVE_MERGE_TO_MAIN
        "COORDINATOR_QUESTION" -> AttentionReason.COORDINATOR_QUESTION
        "ESCALATED" -> AttentionReason.ESCALATED_TO_YOU
        "FUSE_PAUSED" -> AttentionReason.FUSE_PAUSED
        else -> null
    }

    // The drawer (OrbitKit `ProjectAttention`, `MARK: the drawer`).

    /** The four owner items this project is waiting on the reader for, of the kinds this build names. */
    private fun waitingOwnerItems(project: JsonObject): List<JsonObject> {
        if (!open(project)) return emptyList()
        return project.obj("attention")?.objects("ownerItems").orEmpty().filter { it.text("kind") in ownerItemOrder && (it.number("count") ?: 0) > 0 }
    }
    /** The coordinator's request to start this project, while it is open and waiting on the reader. */
    private fun waitingStartRequest(project: JsonObject) = if (open(project)) startRequest(project) else null
    /** The coordinator's request to record this project done, while it is open and waiting on the reader. */
    private fun waitingDoneRequest(project: JsonObject) = if (open(project)) doneRequest(project) else null

    /** How many things wait on the reader in this project — a merge to approve, a question, an escalation, a pause, and a coordinator
     * asking to start it or to record it done — together: the drawer row's amber count (`ProjectAttention.needsYouItemCount`, web's
     * `projectNeedsYouCount`). An owner item of a kind this build does not name counts nothing, and a closed project asks nothing,
     * whatever it still carries. */
    fun needsYouItemCount(project: JsonObject): Int =
        waitingOwnerItems(project).sumOf { it.number("count") ?: 0 } + (if (waitingStartRequest(project) != null) 1 else 0) +
            (if (waitingDoneRequest(project) != null) 1 else 0)

    /** Whether anything is waiting on the reader in this project: one of the four owner items, or its coordinator asking to start it
     * or to record it done. */
    fun needsYou(project: JsonObject) = needsYouItemCount(project) > 0

    /** When the reader was first asked — the oldest of the things waiting on them. */
    private fun oldestWait(project: JsonObject): String? {
        var oldest = waitingStartRequest(project)?.text("waitingSince")
        val done = waitingDoneRequest(project)?.text("waitingSince")
        if (done != null && (oldest == null || byInstantAsc(done, oldest) < 0)) oldest = done
        for (item in waitingOwnerItems(project)) {
            if (oldest == null || byInstantAsc(item.text("oldestWaitingSince"), oldest) < 0) oldest = item.text("oldestWaitingSince")
        }
        return oldest
    }

    /** How many projects have something waiting on the reader in person — the drawer's Projects row's count. Deliberately not the
     * Needs attention lane's size: a project that merely went quiet is not something the reader was asked for. */
    fun needsYouCount(all: List<JsonObject>) = all.count(::needsYou)

    /** A drawer row's mark: how many things wait on the reader; else running while tasks run, its coordinator works — as the live
     * session list says ([coordinator]) when it has the conversation, else as the row's own `coordinatorActivity` says — or a landing
     * is in flight; else idle. */
    fun drawerMark(project: JsonObject, coordinator: CoordinatorPulse? = null): DrawerMark {
        val waiting = needsYouItemCount(project)
        if (waiting > 0) return DrawerMark.NeedsYou(waiting)
        val working = if (coordinator != null) coordinator.working else project.obj("coordinatorActivity")?.flag("working") == true
        if (count(project, "running") > 0 || working || (project.obj("integration")?.number("activeJobCount") ?: 0) > 0) return DrawerMark.Running
        return DrawerMark.Idle
    }

    /** The coordinator conversations in a live session list, by [SessionProjectGrouping.key] of the project each coordinates. The
     * running test is the session list's own spinner ([isRunning]), so the two marks cannot disagree about one conversation. */
    fun coordinatorPulses(sessions: List<DirectorySession>): Map<String, CoordinatorPulse> {
        val pulses = mutableMapOf<String, CoordinatorPulse>()
        for (session in sessions) {
            val projectId = session.projectMembership?.takeIf { it.isCoordinator }?.projectId ?: continue
            val key = SessionProjectGrouping.key(projectId)
            val seen = pulses[key]
            val newest = if (at(session.lastTurnAt) > at(seen?.lastTurnAt)) session.lastTurnAt else seen?.lastTurnAt
            pulses[key] = CoordinatorPulse(session.isRunning() || seen?.working == true, newest)
        }
        return pulses
    }

    /** A project's newest activity: its latest task write, or its coordinator's latest turn when that is newer. */
    private fun latestActivity(project: JsonObject, coordinators: Map<String, CoordinatorPulse>): String? {
        val pulse = project.text("id")?.let { coordinators[SessionProjectGrouping.key(it)] }
        val turn = if (pulse != null) pulse.lastTurnAt else project.obj("coordinatorActivity")?.text("lastTurnAt")
        return if (at(turn) > at(project.text("lastActivityAt"))) turn else project.text("lastActivityAt")
    }

    /** The drawer's project rows: open projects only, the ones waiting on the reader first (longest wait first), then by most recent
     * activity — a task write or a coordinator turn, whichever is newer — then the newest created. */
    fun drawerProjects(all: List<JsonObject>, coordinators: Map<String, CoordinatorPulse> = emptyMap()): List<JsonObject> =
        all.filter(::open).sortedWith { a, b -> drawerOrder(a, b, coordinators) }

    private fun drawerOrder(a: JsonObject, b: JsonObject, coordinators: Map<String, CoordinatorPulse>): Int {
        val aNeeds = needsYou(a); val bNeeds = needsYou(b)
        if (aNeeds != bNeeds) return if (aNeeds) -1 else 1
        if (aNeeds) {
            val byWait = byInstantAsc(oldestWait(a), oldestWait(b))
            if (byWait != 0) return byWait
        }
        val byActivity = byInstantDesc(latestActivity(a, coordinators), latestActivity(b, coordinators))
        if (byActivity != 0) return byActivity
        val byCreated = byInstantDesc(a.text("createdAt"), b.text("createdAt"))
        if (byCreated != 0) return byCreated
        return byId(a, b)
    }

    /** Why an OPEN project needs a visible signal (`ProjectAttention.reason(of:now:)`). */
    fun reason(project: JsonObject, now: Instant): AttentionReason? {
        if (!open(project)) return null
        if (startRequestLeads(project)) return AttentionReason.READY_TO_START
        if (doneRequestLeads(project)) return AttentionReason.DONE_REQUEST
        leadOwnerItem(project)?.let { lead -> reasonFor(lead.text("kind"))?.let { return it } }
        if (autoRemediationBlockers(project) > 0) return AttentionReason.AUTO_REMEDIATION
        if ((project.obj("attention")?.number("userBlockers") ?: 0) > 0) return AttentionReason.NEEDS_USER
        val working = platformWorking(project)
        val quiet = if (working) null else quietDays(project.text("lastActivityAt"), now)
        val running = count(project, "running"); val ready = count(project, "ready")
        if (running > 0 && quiet != null) return AttentionReason.NO_ACTIVITY_RUNNING
        if (running == 0 && ready > 0 && quiet != null) return AttentionReason.NO_ACTIVITY_READY
        if (project.obj("attention")?.obj("coordinatorItems") != null) return AttentionReason.COORDINATOR_HANDLING
        val unsettled = running + ready + count(project, "blocked") + count(project, "awaitingVerification") + failedTaskCount(project)
        if (!working && unsettled == 0 && count(project, "done") + count(project, "cancelled") > 0) return AttentionReason.READY_TO_CLOSE
        return null
    }

    /** Every project lands in exactly one lane; a status this build does not know is Completed. */
    fun lane(project: JsonObject, now: Instant): ProjectLane {
        if (!open(project)) return ProjectLane.COMPLETED
        val reason = reason(project, now)
        if (reason == AttentionReason.AUTO_REMEDIATION || reason?.needsYou == true) return ProjectLane.ATTENTION
        if (platformWorking(project)) return ProjectLane.RUNNING
        val running = count(project, "running"); val ready = count(project, "ready")
        val quietRunning = running > 0 && quietDays(project.text("lastActivityAt"), now) != null
        if (running > 0 && !quietRunning) return ProjectLane.RUNNING
        if (reason != null && reason != AttentionReason.COORDINATOR_HANDLING) return ProjectLane.ATTENTION
        if (reason == AttentionReason.COORDINATOR_HANDLING && ready == 0) return ProjectLane.WAITING
        if (taskCount(project) == 0) return ProjectLane.DEFINITION
        if (ready > 0) return ProjectLane.READY
        if (count(project, "blocked") > 0 || count(project, "awaitingVerification") > 0) return ProjectLane.WAITING
        if (failedTaskCount(project) > 0) return ProjectLane.WAITING
        return ProjectLane.DEFINITION
    }

    private fun severityRank(severity: String?) = when (severity) { "CRITICAL" -> 0; "WARNING" -> 1; "INFO" -> 2; else -> Int.MAX_VALUE }
    private fun severityLabel(severity: String?) = when (severity) { "CRITICAL" -> "Critical"; "WARNING" -> "Warning"; "INFO" -> "Info"; else -> null }

    /** The visible order inside one lane. */
    fun ordered(projects: List<JsonObject>, lane: ProjectLane, now: Instant): List<JsonObject> =
        projects.sortedWith { a, b -> compare(a, b, lane, now) }

    private fun compare(a: JsonObject, b: JsonObject, lane: ProjectLane, now: Instant): Int {
        fun activity(c: Int) = if (c != 0) c else byId(a, b)
        return when (lane) {
            ProjectLane.ATTENTION -> {
                val left = reason(a, now); val right = reason(b, now)
                val byReason = compareValues(left?.rank ?: Int.MAX_VALUE, right?.rank ?: Int.MAX_VALUE)
                if (byReason != 0) return byReason
                if (left != null && right != null && left.needsYou && right.needsYou) {
                    val byWait = byInstantAsc(needsYouSince(a), needsYouSince(b))
                    if (byWait != 0) return byWait
                }
                if ((left == AttentionReason.NEEDS_USER && right == AttentionReason.NEEDS_USER) ||
                    (left == AttentionReason.AUTO_REMEDIATION && right == AttentionReason.AUTO_REMEDIATION)) {
                    val bySeverity = compareValues(severityRank(a.obj("attention")?.text("maxSeverity")), severityRank(b.obj("attention")?.text("maxSeverity")))
                    if (bySeverity != 0) return bySeverity
                    val byAge = byInstantAsc(a.obj("attention")?.text("attentionSinceAt"), b.obj("attention")?.text("attentionSinceAt"))
                    if (byAge != 0) return byAge
                }
                activity(byInstantAsc(a.text("lastActivityAt"), b.text("lastActivityAt")))
            }
            ProjectLane.RUNNING, ProjectLane.COMPLETED -> activity(byInstantDesc(a.text("lastActivityAt"), b.text("lastActivityAt")))
            ProjectLane.DEFINITION -> activity(a.text("title").orEmpty().compareTo(b.text("title").orEmpty(), ignoreCase = true).coerceIn(-1, 1))
            ProjectLane.READY, ProjectLane.WAITING -> activity(byInstantAsc(a.text("lastActivityAt"), b.text("lastActivityAt")))
        }
    }

    /** All six lanes in order, each ordered for display (empty ones included — the view drops them). */
    fun lanes(all: List<JsonObject>, now: Instant): List<Pair<ProjectLane, List<JsonObject>>> {
        val grouped = all.groupBy { lane(it, now) }
        return ProjectLane.entries.map { it to ordered(grouped[it].orEmpty(), it, now) }
    }

    private fun coordinatorLeadCopy(kind: String?) = when (kind) {
        "INTEGRATION_CONFLICT" -> "resolving a merge conflict"
        "INTEGRATION_CHECK_FAILED" -> "checks failed"
        "INTEGRATION_ERROR" -> "handling an integration error"
        "TASK_FAILED" -> "handling a failed task"
        "DELIVERY_REVIEW" -> "reviewing a delivery"
        else -> null
    }

    /** What the row says the owner must do, by the item's kind; a merge names the project's main branch, [main]. */
    fun ownerItemSays(item: JsonObject, main: String = RunSettings.defaultMainBranch): String? {
        val count = item.number("count") ?: 0
        return when (item.text("kind")) {
            "PROMOTION_APPROVAL" -> "Needs you · Approve merge to $main"
            "COORDINATOR_QUESTION" -> "Needs you · $count question${if (count == 1) "" else "s"} from coordinator"
            "ESCALATED" -> "Needs you · $count escalated to you"
            "FUSE_PAUSED" -> "Paused · coordinator stopped itself"
            else -> null
        }
    }

    private fun joined(vararg parts: String?) = parts.filterNotNull().joinToString(" · ")
    private fun plural(n: Int, word: String) = "$n $word${if (n == 1) "" else "s"}"

    /** The chip beside the title, or null for a row that needs none (`ProjectAttention.chip(of:now:)`). */
    fun chip(project: JsonObject, now: Instant): AttentionChip? {
        val reason = reason(project, now) ?: return null
        val attention = project.obj("attention")
        return when (reason) {
            AttentionReason.READY_TO_START -> AttentionChip(true, joined(readyToStartSays, elapsedLabel(startRequest(project)?.text("waitingSince"), now)))
            AttentionReason.DONE_REQUEST -> AttentionChip(true, joined(readyToCloseSays, elapsedLabel(doneRequest(project)?.text("waitingSince"), now)))
            AttentionReason.APPROVE_MERGE_TO_MAIN, AttentionReason.COORDINATOR_QUESTION, AttentionReason.ESCALATED_TO_YOU, AttentionReason.FUSE_PAUSED -> {
                val item = leadOwnerItem(project) ?: return null
                // The row's `mainBranch` (`GET /projects`): the project's main branch, null with no repository bound.
                val says = ownerItemSays(item, RunSettings.mainBranchName(project.text("mainBranch"))) ?: return null
                AttentionChip(true, joined(says, elapsedLabel(item.text("oldestWaitingSince"), now)))
            }
            AttentionReason.COORDINATOR_HANDLING -> {
                val held = attention?.obj("coordinatorItems") ?: return null
                AttentionChip(false, joined("Coordinator", coordinatorLeadCopy(held.text("leadKind")), elapsedLabel(held.text("oldestWaitingSince"), now)))
            }
            AttentionReason.NEEDS_USER -> AttentionChip(true, joined("Needs you", severityLabel(attention?.text("maxSeverity")),
                elapsedDayLabel(attention?.text("attentionSinceAt"), now), plural(attention?.number("userBlockers") ?: 0, "blocker")))
            AttentionReason.AUTO_REMEDIATION -> {
                val user = attention?.number("userBlockers") ?: 0
                AttentionChip(true, joined("Auto-remediation", "Coordinator-owned", severityLabel(attention?.text("maxSeverity")),
                    elapsedDayLabel(attention?.text("attentionSinceAt"), now), plural(autoRemediationBlockers(project), "blocker"),
                    if (user > 0) "$user need you" else null))
            }
            AttentionReason.READY_TO_CLOSE -> {
                val settled = count(project, "done") + count(project, "cancelled")
                val total = listOf("running", "ready", "blocked", "awaitingVerification").sumOf { count(project, it) } + failedTaskCount(project) + settled
                AttentionChip(false, "$settled/$total tasks settled · project still open")
            }
            AttentionReason.NO_ACTIVITY_RUNNING -> quietDays(project.text("lastActivityAt"), now)?.let { AttentionChip(true, "Running · no activity ${it}d") }
            AttentionReason.NO_ACTIVITY_READY -> quietDays(project.text("lastActivityAt"), now)?.let { AttentionChip(true, "Ready · no activity ${it}d") }
        }
    }

    /** The line a row lands on, in the branch's own name; null when no line has been decided. */
    fun integrationChip(project: JsonObject): IntegrationChip? {
        val integration = project.obj("integration") ?: return null
        val ref = integration.text("ref")?.takeIf { it.isNotEmpty() } ?: return null
        return IntegrationChip(ref, integration.text("line") == "PROJECT_BRANCH")
    }

    /** The index's search: title or goal, case-insensitive (`ProjectsListView.filtered`). */
    fun matches(project: JsonObject, query: String): Boolean {
        val needle = query.trim()
        return needle.isEmpty() || project.text("title").orEmpty().contains(needle, ignoreCase = true) ||
            project.text("goal").orEmpty().contains(needle, ignoreCase = true)
    }
}

/** `RelativeTime` for the project pages: the instant reader, and the row's compact age. `ago`/`span`
 * are `SharePanelCopy`'s ports of the same functions. */
object ProjectTime {
    fun parse(iso: String?): Instant? = iso?.let { runCatching { Instant.parse(it) }.getOrNull() }
    fun between(from: Instant, to: Instant): Double = (to.toEpochMilli() - from.toEpochMilli()) / 1000.0
    /** `RelativeTime.elapsed`: "42s", "5m", "3h", "2d". */
    fun elapsed(iso: String?, now: Instant): String? {
        val date = parse(iso) ?: return null
        val diff = maxOf(0.0, between(date, now))
        return when {
            diff < 60 -> "${diff.toInt()}s"
            diff < 3_600 -> "${(diff / 60).toInt()}m"
            diff < 86_400 -> "${(diff / 3_600).toInt()}h"
            else -> "${(diff / 86_400).toInt()}d"
        }
    }
    fun span(seconds: Double): String = io.orbitd.android.taskprojects.SharePanelCopy.span(seconds)
    fun ago(iso: String?, now: Instant): String? = iso?.let { io.orbitd.android.taskprojects.SharePanelCopy.ago(it, now) }
}
