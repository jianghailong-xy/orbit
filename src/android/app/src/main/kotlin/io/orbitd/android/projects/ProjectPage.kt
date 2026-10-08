package io.orbitd.android.projects

import io.orbitd.android.core.cards.*
import io.orbitd.android.taskprojects.SharePanelCopy
import kotlinx.serialization.json.*
import java.time.Instant
import java.time.ZoneId
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

// OrbitKit's project page rules and words (App/ProjectPage.swift, ProjectPageSections.swift,
// ProjectRunSettings.swift, StartProject.swift, ShareMarkdown.swift), ported as pure functions over
// the server's JSON. ProjectPageTest holds them to the Swift cases and sources.

private fun plural(n: Int, one: String, many: String) = "$n ${if (n == 1) one else many}"
private fun seconds(from: Instant, to: Instant) = (to.toEpochMilli() - from.toEpochMilli()) / 1000.0

/** The project document's reads that every section shares (`ProjectDocument`). */
object ProjectDoc {
    fun taskCount(doc: JsonObject) = doc.obj("_count")?.number("tasks") ?: 0
    /** Read off `startedAt` and nothing else; null when the server did not say. */
    fun started(doc: JsonObject): Boolean? = if (!doc.containsKey("startedAt")) null else doc["startedAt"] !is JsonNull
    fun status(doc: JsonObject) = doc.text("status") ?: "UNKNOWN"
    /** "Not started" before the start, "Completed" for DONE, else the status word. */
    fun statusLabel(doc: JsonObject): String = when {
        status(doc) == "OPEN" && started(doc) == false -> StartProjectCopy.notStarted
        status(doc) == "DONE" -> "Completed"
        status(doc) == "OPEN" -> "Open"
        status(doc) == "CANCELLED" -> "Cancelled"
        else -> status(doc)
    }
    fun satisfied(criterion: JsonObject): Boolean? = (criterion["satisfied"] as? JsonPrimitive)?.booleanOrNull
}

enum class Glyph { DISC, TRIANGLE, SQUARE, HOURGLASS, CHECK, CROSS, SLASH, SPINNER, BRANCH }
enum class TagTone { NEUTRAL, BRAND, WARNING, DANGER, SUCCESS, VERIFICATION }
data class OverviewCell(val key: String, val label: String, val value: Int, val footnote: String, val glyph: Glyph)
data class LandingLine(val word: String, val what: String?, val running: Boolean, val state: String, val clock: String, val clockLabel: String, val updated: String?)
data class Pill(val label: String, val tone: TagTone)
data class Tag(val text: String, val tone: TagTone)
data class TaskGroup(val key: String, val heading: String, val tasks: List<JsonObject>, val settled: Boolean = false)
data class CriterionWork(val state: String, val landing: String?, val landingWarning: String?, val landingFlagged: Boolean, val reasons: List<Reason>) {
    data class Reason(val sentence: String, val heldUpBy: List<HeldUp>)
    data class HeldUp(val taskId: String, val title: String, val action: String)
}
data class BlockerHeadline(val tag: String, val tone: TagTone, val title: String)
data class BlockerDecision(val question: String, val acceptLabel: String, val keepLabel: String)

object ProjectPage {
    // MARK: work overview
    const val readyUntilStarted = "starts when you start"
    const val readyWhilePaused = "project is paused"
    fun reportsIntegrationLanes(b: JsonObject) = b["integrating"] is JsonPrimitive && b["onIntegrationLine"] is JsonPrimitive && b["onUpstream"] is JsonPrimitive
    private fun JsonObject.n(key: String) = number(key) ?: 0

    fun overviewCells(b: JsonObject, taskCount: Int, line: String?, started: Boolean?, paused: Boolean = false, manualReadyCount: Int = 0): List<OverviewCell> {
        val readyFootnote = if (started == false) readyUntilStarted else if (paused) readyWhilePaused
            else if (b.n("ready") > 0 && manualReadyCount == b.n("ready")) "can start manually" else "can start now"
        if (reportsIntegrationLanes(b)) {
            val landing = b.n("waitingForLanding")
            val lanes = mutableListOf(
                OverviewCell("running", "Running", b.n("running"), "task work in progress", Glyph.DISC),
                OverviewCell("ready", "Ready", b.n("ready"), readyFootnote, Glyph.TRIANGLE),
                OverviewCell("blocked", "Waiting", b.n("blocked"), if (landing > 0) "$landing waiting for a prerequisite to land" else "waiting on dependencies", Glyph.SQUARE),
                OverviewCell("integrating", "Pending landing", b.n("integrating"), "no landing receipt yet", Glyph.HOURGLASS),
            )
            if (line != "MAIN") lanes += OverviewCell("onIntegrationLine", "On project branch", b.n("onIntegrationLine"), "not on main yet", Glyph.BRANCH)
            lanes += OverviewCell("onUpstream", "On main", b.n("onUpstream"), "landed on main", Glyph.CHECK)
            return lanes + listOf(
                OverviewCell("doneNotIntegrated", "Done", b.n("doneNotIntegrated"), "nothing to land", Glyph.CHECK),
                OverviewCell("awaitingVerification", "Awaiting verification", b.n("awaitingVerification"), "verifier must conclude", Glyph.HOURGLASS),
                OverviewCell("failed", "Failed", b.n("failed"), "coordinated continuation", Glyph.CROSS),
                OverviewCell("cancelled", "Cancelled", b.n("cancelled"), "closed without completion", Glyph.SLASH),
            ).filter { it.value > 0 }
        }
        val complete = if (taskCount > 0) "${(b.n("done").toDouble() / taskCount * 100).roundToInt()}% complete" else "no tasks yet"
        return listOf(
            OverviewCell("running", "Running", b.n("running"), "task work in progress", Glyph.DISC),
            OverviewCell("ready", "Ready", b.n("ready"), readyFootnote, Glyph.TRIANGLE),
            OverviewCell("blocked", "Waiting", b.n("blocked"), "waiting on dependencies", Glyph.SQUARE),
            OverviewCell("awaitingVerification", "Awaiting verification", b.n("awaitingVerification"), "verifier must conclude", Glyph.HOURGLASS),
            OverviewCell("done", "Done", b.n("done"), complete, Glyph.CHECK),
            OverviewCell("failed", "Failed", b.n("failed"), "coordinated continuation", Glyph.CROSS),
            OverviewCell("cancelled", "Cancelled", b.n("cancelled"), "closed without completion", Glyph.SLASH),
        )
    }
    fun overviewSubtitle(shape: JsonObject) = "${plural(shape.n("taskCount"), "task", "tasks")} · ${plural(shape.n("edgeCount"), "dependency", "dependencies")}"

    val integrationJobWords = mapOf("LAND_TASK" to "Landing", "CHECK_PROMOTION" to "Merge check", "LAND_PROMOTION" to "Merge to main")
    val integrationPhaseWords = mapOf("FETCH" to "fetching", "MAIN_SYNC" to "syncing main", "REBASE" to "rebasing", "MERGE" to "merging",
        "CHECK" to "checking", "VERIFY" to "verifying", "PUSH" to "pushing")
    /** Minutes and seconds always: this number is watched while it moves. */
    fun landingClock(seconds: Double): String { val whole = max(0.0, seconds).toInt(); return "${whole / 60}m ${whole % 60}s" }

    /** The landing in flight, or null when nothing is (`landingLine`). */
    fun landingLine(view: JsonObject, now: Instant, updatedAt: Instant?, refreshFailed: Boolean): LandingLine? {
        val inFlight = view.obj("inFlight") ?: return null
        val running = inFlight.text("state") == "RUNNING"
        val jobs = view.n("integratingCount") + view.n("queuedCount")
        val heartbeatAt = inFlight.text("heartbeatAt")?.let(ProjectTime::parse)
        val heartbeatStale = running && heartbeatAt?.let { seconds(it, now) > 600 } == true
        val readStale = updatedAt?.let { seconds(it, now) > 90 } == true
        val unavailable = refreshFailed || readStale || heartbeatStale
        val lastUpdate = if (running) heartbeatAt ?: updatedAt else updatedAt
        val elapsedAt = if (unavailable) minOf(now, lastUpdate ?: now) else now
        val age = lastUpdate?.let { (max(0.0, seconds(it, now)) / 60).toInt() }
        val elapsed = inFlight.text("startedAt")?.let(ProjectTime::parse)?.let { seconds(it, elapsedAt) } ?: 0.0
        return LandingLine(integrationJobWords[inFlight.text("kind")] ?: "Integration", if (jobs > 1) "$jobs jobs" else inFlight.text("taskTitle"),
            running && !unavailable, if (unavailable) "Update unavailable" else if (running) integrationPhaseWords[inFlight.text("phase")] ?: "running" else "queued",
            landingClock(elapsed), if (running) "Elapsed" else "Queued for", age?.let { if (it == 0) "Updated just now" else "Updated ${it}m ago" })
    }

    // MARK: criteria
    const val metByItsWork = "Met by its work"
    const val notMetByItsWork = "Not met by its work"
    private val unmetClause = mapOf(
        "NO_WORK_SERVES_IT" to "No task says it serves this criterion.",
        "SERVING_WORK_UNSETTLED" to "Work filed under it has not settled by the criterion that work declared.",
        "DECLARATION_STALE" to "Work here was filed against an earlier wording of this criterion.",
    )
    private val requiredActionSentence = mapOf(
        "RUN_ACCEPTANCE_COMMAND" to "needs its acceptance command to run",
        "OBTAIN_INDEPENDENT_VERIFICATION_PASS" to "needs an independent verification pass",
        "RECORD_VERIFICATION_VERDICT" to "needs its verdict recorded",
        "SUBMIT_EVIDENCE_AND_AWAIT_INDEPENDENT_DECISION" to "needs evidence submitted, then an independent decision",
    )
    /** null when the read did not answer for it: a third state, never "not met". */
    fun criterionWork(c: JsonObject, integrationRef: String?): CriterionWork? {
        val satisfied = ProjectDoc.satisfied(c) ?: return null
        var landing: String? = null; var warning: String? = null
        if (satisfied) c.text("landing")?.let { raw -> when (raw) {
            "ON_INTEGRATION_LINE" -> { landing = "on ${integrationRef ?: "the project branch"}"; warning = "not on main yet" }
            "LANDED" -> landing = "on main"
            "UNKNOWN" -> landing = "no merge receipt either way"
            else -> landing = raw
        } }
        val reasons = c.objects("unmet").map { reason ->
            CriterionWork.Reason(unmetClause[reason.text("clause")] ?: reason.text("clause").orEmpty(), reason.objects("heldUpBy").map {
                CriterionWork.HeldUp(it.text("taskId").orEmpty(), it.text("title").orEmpty(), requiredActionSentence[it.text("requiredAction")] ?: it.text("requiredAction").orEmpty())
            })
        }
        return CriterionWork(if (satisfied) metByItsWork else notMetByItsWork, landing, warning, satisfied && c.text("landing") == "UNKNOWN", reasons)
    }
    const val criteriaPreviewCompact = 4
    fun criteriaStanding(count: Int) = "$count ${if (count == 1) "criterion" else "criteria"} stated. Whether one is met is read off the work filed under it; nothing in Orbit judges the criteria themselves."
    const val noCriteria = "No criteria are stated for this project."
    fun criteriaDisclosure(total: Int, limit: Int, expanded: Boolean): Pair<String, String>? {
        if (total <= limit) return null
        return (if (expanded) "Show first $limit criteria" else "View all $total criteria") to
            (if (expanded) "Showing all $total criteria" else "${total - limit} more not shown")
    }
    const val criteriaOutcomeNote = "Tasks track process · Nothing judges these criteria."
    const val howItsChecked = "How it's checked"
    const val instructionsHeading = "Instructions"
    const val noInstructions = "No instructions set"

    // MARK: coordinator
    fun coordinatorFinished(status: JsonObject) = status.text("state") == "LIVE" &&
        status.obj("coordination")?.obj("session")?.text("lifecycleState") in setOf("COMPLETED", "ARCHIVED")
    fun coordinatorPill(status: JsonObject): Pill {
        val session = status.obj("coordination")?.obj("session")
        if (status.text("state") == "LIVE" && session != null && !coordinatorFinished(status)) {
            if ((session.number("pendingApprovals") ?: 0) > 0) return Pill("Needs you", TagTone.WARNING)
            val run = session.text("runState")
            if (run == "RUNNING" || (run == "AWAITING_INPUT" && session.flag("engineTurnActive"))) return Pill("Working", TagTone.BRAND)
            if (run == "AWAITING_INPUT") return Pill("Needs you", TagTone.WARNING)
            return Pill("Idle", TagTone.NEUTRAL)
        }
        if (coordinatorFinished(status)) return Pill("Completed", TagTone.NEUTRAL)
        return when (status.text("state")) {
            "NEVER_OPENED" -> Pill("Not started", TagTone.NEUTRAL)
            "TRASHED" -> Pill("Deleted", TagTone.NEUTRAL)
            else -> Pill("Cannot be opened", TagTone.DANGER)
        }
    }
    fun coordinatorOrdinal(generation: String?): String {
        val n = (generation?.toIntOrNull() ?: 0) + 1
        val suffix = if (n % 100 in 11..13) "th" else when (n % 10) { 1 -> "st"; 2 -> "nd"; 3 -> "rd"; else -> "th" }
        return "$n$suffix coordinator of this project"
    }
    fun lastActive(session: JsonObject, readAt: String?): String? {
        val newest = listOf("lastTurnAt", "startedAt", "finishedAt", "completedAt").mapNotNull { session.text(it)?.let(ProjectTime::parse) }.maxOrNull() ?: return null
        val now = readAt?.let(ProjectTime::parse) ?: return null
        val diff = seconds(newest, now)
        return when {
            diff < 60 -> "last active just now"
            diff < 3_600 -> "last active ${(diff / 60).toInt()}m ago"
            diff < 86_400 -> "last active ${(diff / 3_600).toInt()}h ago"
            else -> "last active ${(diff / 86_400).toInt()}d ago"
        }
    }
    private val wakeupWord = mapOf("DELIVERED" to "delivered", "QUEUED" to "queued", "RETURNED" to "returned", "NONE" to "none yet")
    fun wakeupsLine(w: JsonObject, now: Instant): String {
        val state = w.text("state").orEmpty()
        val word = wakeupWord[state] ?: state
        val ago = w.text("at")?.let { SharePanelCopy.ago(it, now) } ?: return word
        return if (state == "DELIVERED") "$word · last $ago" else "$word · $ago"
    }
    fun selfStartedLine(f: JsonObject): String {
        val limit = f.number("limit")
        val count = if (limit != null) "${f.n("selfStartedToday")} of $limit" else "${f.n("selfStartedToday")} · no limit"
        return if (f.flag("paused")) "$count · paused" else count
    }
    fun selfStartedFraction(f: JsonObject): Float? { val limit = f.number("limit")?.takeIf { it > 0 } ?: return null; return min(1f, f.n("selfStartedToday").toFloat() / limit) }
    fun coordinatorPress(finished: Boolean, needsReply: Boolean) = if (finished || !needsReply) "Open coordinator" else "Reply to coordinator"
    fun dispatchNote(openTaskCount: Int?, finished: Boolean): Pair<String, String> {
        if (finished) return "Open work" to when (openTaskCount) {
            null -> "A completed conversation is told nothing new, and this project still points at it."
            0 -> "A completed conversation is told nothing new. No open tasks remain."
            else -> "A completed conversation is told nothing new — and $openTaskCount open task${if (openTaskCount == 1) " still points" else "s still point"} at it."
        }
        return "Manual dispatch" to when (openTaskCount) {
            null -> "Open tasks are coordinated from this conversation."
            0 -> "No open tasks remain."
            else -> "$openTaskCount open task${if (openTaskCount == 1) " is" else "s are"} coordinated from this conversation."
        }
    }
    const val finishedCoordinatorNote = "A new coordinator opens empty — this conversation stays completed and readable, and stops being the one this project is coordinated from."
    const val startNewCoordinator = "Start a new coordinator"
    fun startNewCoordinatorDetail(finished: Boolean) = if (finished)
        "Opens empty. This conversation stays completed and readable, and stops being the one this project is coordinated from."
        else "Completes this conversation first, then opens an empty one. Nothing is deleted — it stays readable."
    const val replaceCoordinatorQuestion = "Complete this conversation and start a new coordinator?"
    const val replaceCoordinatorDetail = "The current conversation is completed — a turn in flight finishes first — and this project starts coordinating from a new, empty one. Nothing is deleted: the completed conversation stays readable."
    const val replaceCoordinatorConfirm = "Complete and start a new one"
    const val replaceCoordinatorKeep = "Keep this coordinator"

    // MARK: open items
    const val openItemsHeading = "Open items"
    const val needsYouGroup = "Needs you"
    const val withCoordinatorGroup = "With the coordinator"
    fun openItemsHint(needsYou: Int, withCoordinator: Int) = "$needsYou need you · $withCoordinator with the coordinator · oldest first"
    fun who(row: JsonObject) = if (row.text("assignee") == "COORDINATOR") "Coordinator" else "You"
    fun waitingLabel(row: JsonObject, now: Instant): String {
        val since = row.text("waitingSince")?.let(ProjectTime::parse) ?: now
        val waited = SharePanelCopy.span(seconds(since, now))
        if (row.text("assignee") == "COORDINATOR") {
            val escalateAt = row.text("escalateAt")?.let(ProjectTime::parse) ?: return "waiting $waited"
            val left = seconds(now, escalateAt)
            return if (left > 0) "$waited · goes to you in ${SharePanelCopy.span(left)}" else "$waited · due to come to you"
        }
        row.text("escalatedAt")?.let { at -> SharePanelCopy.ago(at, now)?.let { return "escalated $it" } }
        return "waiting $waited"
    }
    fun actionLabel(action: String) = when (action) {
        "REVIEW" -> "Review"; "ANSWER" -> "Answer"; "RESUME" -> "Resume"; "OPEN_COORDINATOR" -> "Open coordinator"; "OPEN_TASK_SESSION" -> "Open task session"
        else -> null
    }
    /** The first action the server listed that this client can carry out. */
    fun primaryAction(row: JsonObject): String? = row.strings("actions").firstOrNull { action -> when (action) {
        "REVIEW", "ANSWER", "OPEN_COORDINATOR" -> true
        "RESUME" -> row.text("fuseEpisodeId") != null
        "OPEN_TASK_SESSION" -> row.text("sessionId") != null || row.text("taskId") != null
        else -> false
    } }

    // MARK: integration line
    fun integrationFacts(view: JsonObject, now: Instant): List<String>? {
        val line = view.text("line")?.takeIf { it == "MAIN" || it == "PROJECT_BRANCH" } ?: return null
        val branch = line == "PROJECT_BRANCH"
        val facts = mutableListOf(if (branch) view.text("ref") ?: "project branch" else view.text("upstreamRef") ?: "main")
        if (branch) view.number("commitsAheadOfUpstream")?.let { facts += "$it commit${if (it == 1) "" else "s"} ahead of main at last measurement" }
        if (branch) view.text("lastUpstreamSyncAt")?.let { SharePanelCopy.ago(it, now) }?.let { facts += "synced with main $it" }
        facts += "Running jobs ${view.n("integratingCount")} · Queued ${view.n("queuedCount")}"
        facts += "Last landing check ${when (view.text("mergeCheckOnTip")) { "PASSING" -> "✓ passing"; "FAILING" -> "✕ failing"; else -> "not checked" }}"
        return facts
    }

    // MARK: tasks
    fun workState(t: JsonObject): String {
        t.text("workState")?.let { return it }
        if (t.text("completionPolicy") == "VERIFICATION_PASSED" && (t["verifiesTaskId"] == null || t["verifiesTaskId"] is JsonNull)) return "AWAITING_VERIFICATION"
        return when (val status = t.text("status")) { "DONE", "CANCELLED", "FAILED" -> status; "IN_PROGRESS" -> "RUNNING"; else -> "BLOCKED" }
    }
    fun waitsForLanding(t: JsonObject) = t.text("dependencyState") != "READY" && (t.number("landingWaitCount") ?: 0) > 0
    private val integratingStates = setOf("QUEUED", "RUNNING", "CONFLICT", "CHECK_FAILED", "ERROR", "AWAITING_OWNER")
    private val landedStates = setOf("ON_INTEGRATION_LINE", "ON_UPSTREAM")
    /** "integrating" / "landed" for a done task, by its integration state. */
    fun integrationStage(t: JsonObject): String? {
        if (workState(t) != "DONE") return null
        val state = t.obj("integration")?.text("state") ?: return null
        return if (state in integratingStates) "integrating" else if (state in landedStates) "landed" else null
    }
    fun workTag(t: JsonObject): Tag? = when (workState(t)) {
        "READY" -> Tag(if (t.flag("autoRunWhenReady")) "Ready · automatic dispatch" else "Ready · can start now", TagTone.WARNING)
        "RUNNING" -> Tag("Running", TagTone.BRAND)
        "BLOCKED" -> if (waitsForLanding(t)) null else Tag("Blocked", TagTone.NEUTRAL)
        "AWAITING_VERIFICATION" -> Tag(when (t.text("verificationState")) {
            "FAILED" -> "Verification failed"; "MISSING" -> "Missing verifier"; "RUNNING" -> "Awaiting verification · verifier running"
            "BLOCKED" -> "Awaiting verification · verifier blocked"; "PASSED" -> "Awaiting verification · applying result"; else -> "Awaiting verification"
        }, if (t.text("verificationState") == "FAILED") TagTone.DANGER else TagTone.VERIFICATION)
        "FAILED" -> Tag("Failed", TagTone.DANGER)
        else -> null
    }
    fun integrationTag(t: JsonObject, ref: String?, upstreamRef: String?): Tag? {
        if (waitsForLanding(t)) { val n = t.n("landingWaitCount"); return Tag("Waits for $n task${if (n == 1) "" else "s"} to land", TagTone.NEUTRAL) }
        val integration = t.obj("integration") ?: return null
        val who = if (integration.text("handler") == "OWNER") "you" else "coordinator"
        return when (integration.text("state")) {
            "QUEUED" -> Tag("Queued for integration", TagTone.NEUTRAL)
            "RUNNING" -> if (integration["checksRunningForMs"] == null || integration["checksRunningForMs"] is JsonNull) Tag("Integrating", TagTone.BRAND) else Tag("Integrating · checking", TagTone.BRAND)
            "CONFLICT" -> Tag("Conflict · $who", TagTone.DANGER)
            "CHECK_FAILED" -> Tag("Checks failed · $who", TagTone.DANGER)
            "ERROR" -> Tag("Integration error · $who", TagTone.DANGER)
            "AWAITING_OWNER" -> Tag("Awaiting your approval", TagTone.WARNING)
            "ON_INTEGRATION_LINE" -> Tag("On ${ref ?: "the project branch"}", TagTone.SUCCESS)
            "ON_UPSTREAM" -> Tag("On ${upstreamRef ?: "main"}", TagTone.SUCCESS)
            else -> null
        }
    }
    /** The web's bands, the server's order kept inside each (`taskGroups`). */
    fun taskGroups(items: List<JsonObject>): List<TaskGroup> {
        val running = mutableListOf<JsonObject>(); val integrating = mutableListOf<JsonObject>(); val ready = mutableListOf<JsonObject>()
        val awaiting = mutableListOf<JsonObject>(); val failed = mutableListOf<JsonObject>(); val landing = mutableListOf<JsonObject>()
        val landed = mutableListOf<JsonObject>(); val settled = mutableListOf<JsonObject>(); val byLevel = sortedMapOf<Int, MutableList<JsonObject>>()
        items.forEach { task ->
            val stage = integrationStage(task); val state = workState(task)
            when {
                state == "RUNNING" -> running += task
                stage == "integrating" -> integrating += task
                stage == "landed" -> landed += task
                state == "READY" -> ready += task
                state == "AWAITING_VERIFICATION" -> awaiting += task
                state == "FAILED" -> failed += task
                state == "DONE" || state == "CANCELLED" -> settled += task
                waitsForLanding(task) -> landing += task
                else -> byLevel.getOrPut(task.number("topoLevel") ?: 0) { mutableListOf() } += task
            }
        }
        return buildList {
            fun add(key: String, heading: String, tasks: List<JsonObject>, settled: Boolean = false) { if (tasks.isNotEmpty()) add(TaskGroup(key, heading, tasks, settled)) }
            add("running", "Running", running)
            add("integrating", "Pending landing", integrating)
            add("ready", "Ready · can start now", ready)
            add("awaiting-verification", "Awaiting verification · subject work must not be started", awaiting)
            add("failed", "Failed · coordinated continuation", failed)
            add("waiting-for-landing", "Waiting · for a prerequisite to land", landing)
            byLevel.forEach { (level, tasks) -> add("level-$level", if (level == 0) "Blocked · no executable work at this level" else "Blocked · topology level $level", tasks) }
            add("landed", "Landed", landed)
            add("settled", "Done / Cancelled", settled, settled = true)
        }
    }
    fun rowTags(task: JsonObject, heading: String, ref: String?, upstreamRef: String?): List<Tag> = buildList {
        workTag(task)?.let { lane -> if (lane.text != heading && !heading.startsWith(lane.text + " · ")) add(lane) }
        integrationTag(task, ref, upstreamRef)?.let(::add)
    }
    fun taskGlyph(t: JsonObject) = when (t.text("status")) { "IN_PROGRESS" -> Glyph.DISC; "OPEN" -> Glyph.TRIANGLE; "DONE" -> Glyph.CHECK; "FAILED" -> Glyph.CROSS; else -> Glyph.SQUARE }

    // MARK: work overview when the work is not moving
    fun manualReady(queue: JsonObject?, status: String, started: Boolean?, paused: Boolean): JsonObject? {
        if (status != "OPEN" || started == false || paused) return null
        return queue?.obj("manualReady")?.takeIf { (it.number("count") ?: 0) > 0 }
    }
    const val manualReadyTitle = "Ready to start"
    const val manualReadyPress = "Open task"
    fun manualReadySentence(count: Int) = "$count task${if (count == 1) " is" else "s are"} set to start manually."
    fun wrappingUp(status: String, b: JsonObject, inFlight: JsonObject?): Boolean =
        status == "OPEN" && b.n("running") == 0 && b.n("ready") == 0 && b.n("blocked") == 0 && b.n("awaitingVerification") == 0 && b.n("failed") == 0 &&
            b.n("done") + b.n("cancelled") > 0 && b.n("integrating") == 0 && b.n("onIntegrationLine") == 0 && inFlight == null
    const val wrapUpTitle = "Ready to wrap up"
    fun wrapUpSentence(settled: Int) = "All $settled task${if (settled == 1) " is" else "s are"} settled. The project stays open until its outcome is confirmed."

    // MARK: blockers
    private val blockerReasonHeadlines = mapOf(
        "OUTSIDE_DECLARED_SCOPE" to BlockerHeadline("Needs your approval", TagTone.WARNING, "Changed files it didn’t declare"),
        "ACCEPTANCE_STANDARD_MOVED" to BlockerHeadline("Standard moved", TagTone.WARNING, "Its acceptance criterion changed after it started"),
        "CRITERION_EXEMPTION_ARGUED" to BlockerHeadline("Needs your decision", TagTone.WARNING, "Agent says this criterion doesn’t apply"),
        "MERGE_REFUSED_BY_GIT" to BlockerHeadline("Merge conflict", TagTone.DANGER, "Git refused to merge it"),
    )
    private fun reason(blocker: JsonObject) = blocker.obj("detail")?.text("reason")
    fun blockerHeadline(blocker: JsonObject): BlockerHeadline {
        reason(blocker)?.let { blockerReasonHeadlines[it] }?.let { return it }
        val (tag, tone) = when (blocker.text("owner")) { "USER" -> "Needs you" to TagTone.WARNING; "COORDINATOR" -> "Coordinator" to TagTone.BRAND; else -> "System" to TagTone.NEUTRAL }
        val kind = blocker.text("kind").orEmpty()
        val words = kind.lowercase().split("_").filter { it.isNotEmpty() }.joinToString(" ")
        return BlockerHeadline(tag, tone, if (words.isEmpty()) kind else words.replaceFirstChar { it.uppercase() })
    }
    fun blockerSubjectLine(blocker: JsonObject): String? {
        val parts = listOfNotNull(blocker.text("subjectTitle")?.takeIf { it.isNotEmpty() }) +
            if (reason(blocker) == "ACCEPTANCE_STANDARD_MOVED" && blocker.number("criterionOrdinal") != null && blocker.number("criterionRevision") != null)
                listOf("criterion ${blocker.number("criterionOrdinal")} is now revision ${blocker.number("criterionRevision")}") else emptyList()
        return parts.takeIf { it.isNotEmpty() }?.joinToString(" · ")
    }
    private val blockerDecisions = mapOf(
        "CRITERION_EXEMPTION_ARGUED" to BlockerDecision("Does the agent’s explanation make this criterion inapplicable to this work?", "Accept the explanation", "Leave it open"),
        "OUTSIDE_DECLARED_SCOPE" to BlockerDecision("Are these extra files part of the delivery you want to accept?", "Accept these files", "Leave it open"),
        "ACCEPTANCE_STANDARD_MOVED" to BlockerDecision("Does this delivery satisfy the criterion as it reads today?", "Confirm it meets the criterion", "Leave it open"),
        "MERGE_REFUSED_BY_GIT" to BlockerDecision("Has the merge conflict been resolved and checked?", "Mark the conflict resolved", "Leave it open"),
    )
    fun blockerDecision(blocker: JsonObject) = reason(blocker)?.let { blockerDecisions[it] }
    fun blockerPathsLine(paths: List<String>): String? {
        val first = paths.firstOrNull() ?: return null
        val folder = first.lastIndexOf('/').let { if (it >= 0) first.substring(0, it + 1) else "" }
        val shown = paths.take(2).mapIndexed { index, path ->
            val rest = path.drop(folder.length)
            if (index > 0 && folder.isNotEmpty() && path.startsWith(folder) && '/' !in rest) rest else path
        }
        val hidden = paths.size - shown.size
        return (shown + if (hidden > 0) listOf("+$hidden") else emptyList()).joinToString(" · ")
    }
    fun blockerSince(firstSeenAt: String?, now: Instant): String {
        val at = firstSeenAt?.let(ProjectTime::parse) ?: return "since just now"
        val elapsed = seconds(at, now)
        return when { elapsed < 60 -> "since just now"; elapsed < 3_600 -> "since ${(elapsed / 60).toInt()}m"; elapsed < 86_400 -> "since ${(elapsed / 3_600).toInt()}h"; else -> "since ${(elapsed / 86_400).toInt()}d" }
    }
    fun blockerResolution(blocker: JsonObject, zone: ZoneId = ZoneId.systemDefault()): String {
        val whenText = blocker.text("resolvedAt")?.let(ProjectTime::parse)?.atZone(zone)?.let { " (%02d-%02d %02d:%02d)".format(it.monthValue, it.dayOfMonth, it.hour, it.minute) } ?: ""
        val note = blocker.text("resolutionNote")?.trim().orEmpty()
        return when (blocker.text("resolvedBy")) {
            "AUTO" -> "Auto-resolved — ${note.ifEmpty { "its condition no longer holds" }}$whenText"
            "USER" -> "Resolved by you — ${note.ifEmpty { "no reason was recorded" }}$whenText"
            "COORDINATOR" -> "Resolved by the coordinator${if (note.isEmpty()) "" else " — $note"}$whenText"
            else -> "Resolved$whenText"
        }
    }
    fun blockersOpen(count: Int) = "$count open"
    fun blockerName(blocker: JsonObject) = listOf(blockerHeadline(blocker).title, blocker.text("subjectTitle").orEmpty()).filter { it.isNotEmpty() }.joinToString(" · ")
    fun blockerResolvedLine(blocker: JsonObject, zone: ZoneId = ZoneId.systemDefault()) = "${blockerName(blocker)} — ${blockerResolution(blocker, zone)}"
    fun blockersResolvedSummary(blockers: JsonObject, zone: ZoneId = ZoneId.systemDefault()): String? {
        val count = blockers.number("resolvedCount") ?: 0
        val latest = blockers.objects("resolved").firstOrNull()
        if (count <= 0 || latest == null) return null
        return "$count resolved · latest: ${blockerResolution(latest, zone)}"
    }
    const val resolveBlockerNote = "Accepting records your name and note"
    const val blockerDecisionLabel = "Your decision"
    const val blockerArgumentLabel = "Agent’s explanation"
    const val blockerCriterionLabel = "Current criterion"
    const val blockerFilesLabel = "Files this blocker names"
    const val blockerReasonLimit = 2000
    fun resolveBlockerMessage(blocker: JsonObject): String {
        val r = reason(blocker)
        val argument = blocker.text("agentArgument")?.trim().orEmpty()
        val criterion = blocker.text("criterionText")?.trim().orEmpty()
        val paths = blocker.obj("detail")?.strings("paths").orEmpty()
        return buildList {
            add(blockerName(blocker))
            blockerDecision(blocker)?.let { add("$blockerDecisionLabel\n${it.question}") }
            if (r == "CRITERION_EXEMPTION_ARGUED" && argument.isNotEmpty()) add("$blockerArgumentLabel\n$argument")
            if ((r == "CRITERION_EXEMPTION_ARGUED" || r == "ACCEPTANCE_STANDARD_MOVED") && criterion.isNotEmpty()) add("$blockerCriterionLabel\n$criterion")
            if (paths.isNotEmpty()) add((listOf(blockerFilesLabel) + paths).joinToString("\n"))
            add("$resolveBlockerNote.")
        }.joinToString("\n\n")
    }
    fun resolveBlockerPress(blocker: JsonObject) = if (blockerDecision(blocker) == null) "Resolve…" else "Review…"
    fun resolveBlockerTitle(blocker: JsonObject) = if (blockerDecision(blocker) == null) "Resolve this blocker" else "Review this blocker"
    fun resolveBlockerQuestion(blocker: JsonObject) = if (blockerDecision(blocker) == null) "Why is it no longer blocking?" else "What did you verify?"
    fun resolveBlockerConfirm(blocker: JsonObject) = blockerDecision(blocker)?.acceptLabel ?: "Resolve"
    fun resolveBlockerKeep(blocker: JsonObject) = blockerDecision(blocker)?.keepLabel ?: "Cancel"

    // MARK: run queue
    fun queueSummary(q: JsonObject): String {
        val parts = buildList {
            if (q.n("runningCount") > 0) add("${q.n("runningCount")} running")
            if (q.n("queuedCount") > 0) add("${q.n("queuedCount")} queued")
            add("${q.n("readyCount")} ready")
            if (q.n("pausedCount") > 0) add("${q.n("pausedCount")} ready in paused lists")
        }
        val active = q.n("runningCount") + q.n("queuedCount") > 0
        val ranking = if (q.obj("impactTruncated") != null) (if (active) "active first · remaining tasks in stable order" else "stable order")
            else if (active) "ready tasks sorted by work unblocked" else "sorted by work unblocked"
        return (parts + ranking).joinToString(" · ")
    }
    fun queueHelp(q: JsonObject) = buildList {
        if (q.n("runningCount") + q.n("queuedCount") > 0) add("Active tasks stay here until their run ends.")
        if (q.n("readyCount") > 0) add("Ready tasks can start now.")
        if (q.n("pausedCount") > 0) add("Paused candidates meet every other run requirement; resume their task list to make Run available.")
    }.joinToString(" ")
    const val queueEmpty = "No tasks are ready, running, or otherwise ready inside a paused task list. A task appears here when its prerequisites are complete and it has an assigned workspace."
    fun queueImpactTruncated(maxTasks: Int) = "Impact ranking not computed" to
        "This project has more than $maxTasks unfinished tasks, so tasks are shown without downstream impact ranking."
    fun queueRowState(item: JsonObject) = when (item.text("runState")) {
        "RUNNING" -> "Work in progress"
        "QUEUED" -> "Waiting for runner"
        "PAUSED" -> item.obj("pausedList")?.text("title")?.takeIf { it.isNotEmpty() }?.let { "List paused · $it" } ?: "List paused"
        else -> "Prerequisites complete"
    }
    fun queueImpact(item: JsonObject): String {
        val n = item.number("downstreamBlocked") ?: return when (item.text("runState")) { "READY" -> "Ready now"; "PAUSED" -> "Ready after resume"; else -> "Impact not ranked" }
        return "Unblocks $n ${if (n == 1) "task" else "tasks"}"
    }
    const val runPress = "Run"
    const val runPressStarting = "Starting"
    const val openRunSession = "Open session"
    const val resumeListPress = "Resume list"
    const val resumeListNote = "Resumed from the project Run queue"
    fun queueRowTag(state: String?) = when (state) { "RUNNING" -> "Running"; "PAUSED" -> "Paused"; else -> "Queued" }
    fun resumeListQuestion(list: JsonObject) = "Resume “${list.text("title").orEmpty()}”?"
    fun resumeListDetail(item: JsonObject): String {
        val list = item.obj("pausedList") ?: return "This task list must be resumed before the task can run."
        val ready = list.n("readyCount")
        val eligible = "$ready otherwise-ready ${if (ready == 1) "task" else "tasks"}"
        val auto = list.n("autoRunReadyCount")
        val immediate = if (auto > 0) " $auto ${if (auto == 1) "is" else "are"} configured to auto-run and may start immediately." else ""
        return "This removes the pause from the entire list. $eligible will become eligible.$immediate Other automatic or scheduled work in the list can also dispatch once resumed."
    }

    // MARK: the ⋯ menu's status questions (ProjectsView.swift)
    fun confirmTitle(status: String, title: String) = when (status) {
        "DONE" -> "Record “$title” as done?"; "CANCELLED" -> "Stop pursuing “$title”?"; else -> "Reopen “$title”?"
    }
    fun confirmButton(status: String) = when (status) { "DONE" -> "Record as done"; "CANCELLED" -> "Record as cancelled"; else -> "Reopen" }
    fun confirmMessage(status: String, doc: JsonObject, buckets: JsonObject?): String = when (status) {
        "DONE" -> {
            val criteria = doc.objects("acceptanceCriteriaItems")
            val settled = criteria.count { ProjectDoc.satisfied(it) == true }
            val noReceipt = criteria.count { it.text("landing") == "UNKNOWN" }
            "${criteria.size} stated ${if (criteria.size == 1) "criterion" else "criteria"} · $settled settled by the work filed under them · $noReceipt with no merge receipt"
        }
        "CANCELLED" -> {
            val unfinished = buckets?.let { it.n("running") + it.n("ready") + it.n("blocked") + it.n("awaitingVerification") + it.n("failed") } ?: 0
            "$unfinished unfinished ${if (unfinished == 1) "task stays" else "tasks stay"} filed under it and won’t start. A run already going is not stopped."
        }
        else -> "Reopening puts this project back to Open, so its tasks can start again, and changes nothing else: its tasks, its stated criteria and its history stay as they are."
    }
    const val deleteTitle = "Delete this project?"
    const val deleteMessage = "Only a project with no tasks can be deleted."
    const val deletePress = "Delete project"
    const val gone = "This project is gone"
    const val goneDetail = "It was deleted, or it belongs to another account."
    const val loadFailed = "The project couldn't be loaded"
    const val listLoadFailed = "Projects couldn't be loaded"
    const val listLoadFailedDetail = "Check the connection, then try again."
    const val noProjects = "No projects"
    const val noProjectsDetail = "Ask an agent in any session to start a project: it files the goal, the criteria and the first tasks, and the project shows up here."
    const val searchProjects = "Search projects"
}

/** "Start this project?" as the project page, the owner's sheet and the coordinator's card say it — OrbitKit's
 * `StartProject` (StartProject.swift, ProjectRunSettings.swift) with `CriteriaDecision.swift`'s seal words. */
object StartProjectCopy {
    const val title = "Start this project?"
    const val readyToStart = "Ready to start"
    const val doneWhen = "Done when"
    const val plan = "Plan"
    const val howItRuns = "How it runs"
    const val viewTasks = "View tasks ›"
    const val action = "Start the project"
    const val nobodyAsked = "Nobody asked yet"
    const val noCoordinatorYet = "no coordinator yet"
    const val coordinator = "Coordinator"
    const val more = "More"
    const val less = "Less"
    const val notRecorded = "That start was not recorded"
    const val requestGone = "The plan changed after the coordinator asked, so this request no longer stands. Orbit " +
        "shows the card again when the coordinator asks to start the new plan."
    const val opensCoordinator = "This project has no coordinator yet. Orbit opens one where its tasks run when it starts."
    const val now = "Now"
    const val you = "You"
    const val notStarted = "Not started"
    const val rowAsked = "The coordinator asked"
    const val rowOwn = "Start…"
    const val rowNotAsked = "not asked yet"
    const val coordinatorAsked = "The coordinator asked"
    const val showLess = "Show less"
    fun readAll(count: Int) = "Read all $count in full"
    /** `AcceptanceConfirmations.staleExplanation(nil)`: the seal could not be read, so no press is offered. */
    const val unreadSeal = "This card could not be re-read just now, so the version it would confirm cannot be named — and a confirmation " +
        "that names no version is not one. The criteria themselves are untouched by this."
    const val maxConcurrentTasks = 100
    /** The escalation window a project has when the read does not say. */
    const val defaultEscalationSeconds = 7_200
    /** `CriteriaDecisions.shortSeal`: enough to tell two seals apart. */
    fun shortSeal(seal: String) = if (seal.isEmpty()) "(unreadable)" else seal.take(12)
    /** The project branch as the first option names it, without `refs/heads/`. */
    fun branch(projectBranchName: String?, projectId: String) = (projectBranchName ?: "refs/heads/project/$projectId").removePrefix("refs/heads/")

    fun doneWhenHead(count: Int) = "$doneWhen · $count ${if (count == 1) "criterion" else "criteria"}"
    /** "Plan · 12 tasks in 7 levels": the levels only when there are more than one. */
    fun planHead(count: Int, levels: Int = 1): String {
        val head = "$plan · $count ${if (count == 1) "task" else "tasks"}"
        return if (levels > 1) "$head in $levels levels" else head
    }
    /** "The coordinator asked 56m ago"; a time the clock cannot say is the words alone. */
    fun askedLine(ago: String?) = ago?.let { "$coordinatorAsked $it" } ?: coordinatorAsked
    fun nobodyAskedLine(hasCoordinator: Boolean) = if (hasCoordinator) nobodyAsked else "$nobodyAsked · $noCoordinatorYet"
    fun explanation(count: Int) = "Orbit derives done from these $count criteria and nothing else. If they change later, it " +
        "asks you to confirm the new version — the project keeps running."
    /** What pressing Start does: who it opens, what starts at once, what it confirms — the seal left out when it opens a coordinator. */
    fun barCaption(opensCoordinator: Boolean, startsNow: List<String>, criteria: Int, seal: String): String {
        val parts = buildList {
            if (opensCoordinator) add("opens a coordinator")
            if (startsNow.isNotEmpty()) add("starts ${joinAnd(startsNow)} now")
            add(if (criteria == 1) "confirms this criterion" else "confirms these $criteria criteria")
            if (!opensCoordinator) add("seal $seal")
        }
        val line = parts.joinToString(" · ")
        return line.take(1).uppercase() + line.drop(1)
    }

    // The footnote under How it runs.
    const val automaticByDefault = "Automatic is on by default"
    const val coordinatorSuggestedOff = "the coordinator suggested off"
    const val restSuggested = "The rest is the coordinator’s suggestion."
    const val changeLater = "You can change any of these later on the project page."
    fun howItRunsNote(asked: Boolean, suggestedOff: Boolean): String {
        val automatic = if (suggestedOff) "$automaticByDefault ($coordinatorSuggestedOff)." else "$automaticByDefault."
        return (listOf(automatic) + (if (asked) listOf(restSuggested) else emptyList()) + changeLater).joinToString(" ")
    }

    // What still comes to the owner under the Automatic switch.
    const val comesToYou = "Comes to you"
    const val decideDone = "Whether each task is done"
    const val youConfirm = "you confirm it"
    const val problems = "Problems along the way"
    const val problemsDetail = "conflicts, failed checks"
    const val mergingIntoMain = "Merging the branch into main"
    const val eachMergeIntoMain = "Each merge into main"
    const val criteriaChanges = "Any change to the criteria"
    fun reviews(count: Int) = "$count ${if (count == 1) "review" else "reviews"}"
    fun tasksYouConfirm(count: Int) = "$count tasks you confirm"
    fun problemsUnresolved(within: String) = "Problems it can’t resolve within $within"
    /** An escalation window as the list says it: "30 min", "2 h". */
    fun within(seconds: Int) = if (seconds < 3600) "${max(1, (seconds / 60.0).roundToInt())} min" else "${(seconds / 3600.0).roundToInt()} h"
    data class ComesToYouItem(val text: String, val detail: String? = null)
    /** The Automatic switch's consequence, listed (`StartProject.comesToYou`). */
    fun comesToYou(automatic: Boolean, line: String, ownerConfirmed: List<NamedTask>, evidenceJudged: Int, escalationSeconds: Int): List<ComesToYouItem> {
        val confirms = if (ownerConfirmed.size > 3) listOf(ComesToYouItem(tasksYouConfirm(ownerConfirmed.size)))
            else ownerConfirmed.map { ComesToYouItem("${it.label} · ${it.title}", youConfirm) }
        val merges = if (line == "MAIN") listOf(ComesToYouItem(eachMergeIntoMain)) else if (automatic) emptyList() else listOf(ComesToYouItem(mergingIntoMain))
        val criteria = ComesToYouItem(criteriaChanges)
        if (automatic) return confirms + merges + criteria + ComesToYouItem(problemsUnresolved(within(escalationSeconds)))
        return listOf(ComesToYouItem(decideDone, if (evidenceJudged > 0) reviews(evidenceJudged) else null)) + confirms +
            ComesToYouItem(problems, problemsDetail) + merges + criteria
    }

    // The plan, by level.
    /** What the plan calls a task: the marker or code its title opens with, else the title, cut short. */
    fun planTaskLabel(title: String): String {
        val text = title.trim()
        val points = text.codePoints().toArray()
        points.firstOrNull()?.let { first -> if (first in 0x2460..0x2473 || first in 0x2776..0x277F) return String(Character.toChars(first)) }
        leadingMarker(points)?.let { return it }
        leadingCode(points)?.let { return it }
        if (points.size <= 24) return text
        return String(points, 0, 23) + "…"
    }
    /** Swift's `Unicode.Scalar.Properties.isWhitespace`: the White_Space property. */
    private fun white(c: Int) = c in 0x09..0x0D || c == 0x20 || c == 0x85 || c == 0xA0 || c == 0x1680 || c in 0x2000..0x200A ||
        c == 0x2028 || c == 0x2029 || c == 0x202F || c == 0x205F || c == 0x3000
    private fun digit(c: Int) = c in '0'.code..'9'.code
    private fun among(c: Int, set: String) = set.codePoints().anyMatch { it == c }
    /** One ASCII letter or one or two digits, then `.`, `)`, `:` or `：`, or spaces and a lone `· - – — : ： |`. */
    private fun leadingMarker(s: IntArray): String? {
        val first = s.firstOrNull() ?: return null
        val lengths = when {
            first < 128 && Character.isLetter(first) -> listOf(1)
            digit(first) -> if (s.size > 1 && digit(s[1])) listOf(2, 1) else listOf(1)
            else -> return null
        }
        fun separatorFollows(p: Int): Boolean {
            if (p >= s.size) return false
            if (among(s[p], ".):：")) return true
            var q = p
            while (q < s.size && white(s[q])) q++
            if (q <= p || q >= s.size || !among(s[q], "·-–—:：|")) return false
            return q + 1 == s.size || white(s[q + 1])
        }
        return lengths.firstOrNull { separatorFollows(it) }?.let { String(s, 0, it) }
    }
    /** A capital, one or two digits and at most one small letter — "P1", "D12", "P1a" — then `.`, `)`, `:`, `：` or a space. */
    private fun leadingCode(s: IntArray): String? {
        if (s.size <= 2 || s[0] !in 'A'.code..'Z'.code || !digit(s[1])) return null
        var length = if (digit(s[2])) 3 else 2
        if (length < s.size && s[length] in 'a'.code..'z'.code) length++
        if (length >= s.size || !(among(s[length], ".):：") || white(s[length]))) return null
        return String(s, 0, length)
    }
    /** "A, B and C". */
    fun joinAnd(words: List<String>) = if (words.size <= 1) words.firstOrNull().orEmpty() else "${words.dropLast(1).joinToString(", ")} and ${words.last()}"
    /** A task's title without the label the plan calls it by: "P1a · wiki-worker …" → "wiki-worker …". */
    fun planTaskRest(title: String, label: String): String {
        val text = title.trim()
        if (label == text || !text.startsWith(label)) return text
        var rest = text.substring(label.length).codePoints().toArray().dropWhile(::white)
        if (rest.isNotEmpty() && among(rest.first(), ".):：·-–—|")) rest = rest.drop(1)
        val trimmed = rest.dropWhile(::white)
        return if (trimmed.isEmpty()) text else String(trimmed.toIntArray(), 0, trimmed.size)
    }
    fun inParallel(count: Int) = "$count in parallel"
    data class PlanTask(val id: String, val title: String, val after: List<String> = emptyList(), val completionCriterion: String? = null,
        val autoRunWhenReady: Boolean? = null)
    /** One task as a level lists it: `now` — first level and not set to start by hand; `you` — the owner confirms it. */
    data class LevelTask(val id: String, val label: String, val title: String, val now: Boolean, val you: Boolean)
    data class NamedTask(val label: String, val title: String)
    /** A task sits one level after the deepest of what it waits on; an edge out of the plan waits on nothing, a cycle is cut. */
    fun planLevels(tasks: List<PlanTask>): List<List<LevelTask>> {
        val known = tasks.map { it.id }.toSet()
        val prerequisites = tasks.associate { task -> task.id to task.after.filter { it in known && it != task.id }.distinct() }
        val level = mutableMapOf<String, Int>()
        fun depth(id: String, seen: MutableSet<String>): Int {
            level[id]?.let { return it }
            if (!seen.add(id)) return 0
            val at = prerequisites[id].orEmpty().maxOfOrNull { 1 + depth(it, seen) } ?: 0
            level[id] = at
            return at
        }
        val levels = mutableListOf<MutableList<LevelTask>>()
        tasks.forEach { task ->
            val at = depth(task.id, mutableSetOf())
            while (levels.size <= at) levels += mutableListOf<LevelTask>()
            levels[at] += LevelTask(task.id, planTaskLabel(task.title), task.title, at == 0 && task.autoRunWhenReady != false,
                task.completionCriterion == "OWNER_CONFIRMED")
        }
        return levels.filter { it.isNotEmpty() }
    }
    /** The plan as the card reads it: `levels` null when the graph came back folded (a plan too big to list). */
    data class PlanView(val count: Int, val levels: List<List<LevelTask>>?, val ownerConfirmed: List<NamedTask> = emptyList(),
        val evidenceJudged: Int = 0, val startsNow: List<String> = emptyList())
    /** Off the project's graph: the tasks nothing cancelled, in levels; settled ones are counted and not listed. */
    fun planView(graph: DependencyGraph?, fallbackCount: Int): PlanView {
        if (graph == null || graph.truncated || graph.marks.any { it.kind != MarkKind.TASK }) return PlanView(graph?.taskCount ?: fallbackCount, null)
        val tasks = graph.marks.filter { it.status != "CANCELLED" }
        val planned = tasks.filter { it.status != "DONE" }.map { mark ->
            PlanTask(mark.id, mark.title, graph.edges.filter { it.target == mark.id }.map { it.source }, mark.completionCriterion, mark.autoRunWhenReady)
        }
        val levels = if (planned.isEmpty()) null else planLevels(planned)
        return PlanView(tasks.size, levels,
            planned.filter { it.completionCriterion == "OWNER_CONFIRMED" }.map { val label = planTaskLabel(it.title); NamedTask(label, planTaskRest(it.title, label)) },
            planned.count { it.completionCriterion == "EVIDENCE_JUDGMENT" }, levels?.firstOrNull().orEmpty().filter { it.now }.map { it.label })
    }

    fun requestSummary(settings: JsonObject) = listOf(rowAsked, RunSettings.lineInSentence(settings.text("line")),
        "${RunSettings.automatic} ${if (settings.flag("automatic")) "on" else "off"}", "at most ${settings.number("maxConcurrentTasks") ?: 1} at a time").joinToString(" · ")
    /** The plan has dependencies when a run is filed or a live edge joins two live marks. */
    fun planHasDependencies(graph: DependencyGraph): Boolean {
        fun status(mark: GraphMark) = if (mark.kind == MarkKind.TASK) mark.status.orEmpty() else when {
            (mark.statusCounts["FAILED"] ?: 0) > 0 -> "FAILED"; (mark.statusCounts["IN_PROGRESS"] ?: 0) > 0 -> "IN_PROGRESS"
            (mark.statusCounts["OPEN"] ?: 0) > 0 -> "OPEN"; else -> "DONE"
        }
        val live = graph.marks.filter { status(it) != "CANCELLED" }.map { it.id }.toSet()
        return graph.marks.any { it.kind == MarkKind.RUN } || graph.edges.any { it.source in live && it.target in live }
    }
    data class Settings(val line: String, val projectBranchName: String?, val automatic: Boolean, val maxConcurrentTasks: Int, val mergeCheckCommand: String?)
    /** `StartProject.defaultSettings`: the decided line, else a branch when the plan has dependencies. */
    fun defaultSettings(view: JsonObject?, maxConcurrentTasks: Int?, graph: DependencyGraph?): Settings {
        val decided = view?.text("line")?.takeIf { it == "MAIN" || it == "PROJECT_BRANCH" }
        val line = decided ?: if (graph?.let(::planHasDependencies) == true) "PROJECT_BRANCH" else "MAIN"
        val branch = if (decided == "PROJECT_BRANCH") view?.text("ref")?.takeIf { it.isNotEmpty() }?.let { "refs/heads/$it" } else null
        return Settings(line, branch, true, maxConcurrentTasks ?: 1, view?.text("mergeCheckCommand"))
    }

    /** What the card is drawn from (`ProjectStartRequest`): the coordinator's request, or the owner's own with nobody quoted. */
    data class Request(val settings: Settings, val why: String, val criteriaDigest: String)
    fun ownerRequest(settings: Settings, criteriaDigest: String) = Request(settings, "", criteriaDigest)
    /** The open `START_REQUEST` row's request, or null when its settings are not whole settings this build can read. */
    fun request(row: JsonObject?): Request? {
        val asked = row?.obj("startRequest") ?: return null
        val settings = asked.obj("settings") ?: return null
        val line = settings.text("line")?.takeIf { it == "MAIN" || it == "PROJECT_BRANCH" } ?: return null
        val automatic = (settings["automatic"] as? JsonPrimitive)?.booleanOrNull ?: return null
        val count = settings.number("maxConcurrentTasks")?.takeIf { it >= 0 } ?: return null
        val check = when (val value = settings["mergeCheckCommand"]) { null, JsonNull -> null; is JsonPrimitive -> if (value.isString) value.content else return null; else -> return null }
        val digest = asked.text("criteriaDigest") ?: return null
        return Request(Settings(line, settings.text("projectBranchName"), automatic, count, check), asked.text("why").orEmpty(), digest)
    }
    /** The settings as the card edits them — opened with Automatic on whatever was suggested (`StartSettingsDraft`). */
    data class Draft(val line: String, val automatic: Boolean, val maxConcurrentTasks: Int, val mergeCheckCommand: String = "") {
        val complete get() = (line == "MAIN" || line == "PROJECT_BRANCH") && maxConcurrentTasks in 1..StartProjectCopy.maxConcurrentTasks
        val hasMergeCheck get() = mergeCheckCommand.isNotBlank()
        companion object { fun of(settings: Settings) = Draft(settings.line, true, settings.maxConcurrentTasks, settings.mergeCheckCommand.orEmpty()) }
    }
    /** `StartProject.body`: the seal, every setting, and the request answered — the branch only with a project branch, a blank check as none. */
    fun body(request: Request, draft: Draft, requestId: String?): JsonObject = buildJsonObject {
        val branch = request.settings.projectBranchName.orEmpty()
        val check = draft.mergeCheckCommand.trim()
        put("criteriaDigest", request.criteriaDigest); put("line", draft.line)
        if (draft.line == "PROJECT_BRANCH" && branch.isNotEmpty()) put("projectBranchName", branch)
        put("automatic", draft.automatic); put("maxConcurrentTasks", draft.maxConcurrentTasks)
        put("mergeCheckCommand", if (check.isEmpty()) JsonNull else JsonPrimitive(check))
        put("requestId", requestId?.let(::JsonPrimitive) ?: JsonNull)
    }

    /** The request asked about right now: the open `START_REQUEST` of a project nobody has started, or null — also while a read has not answered. */
    fun live(openItems: JsonObject?, started: Boolean?): JsonObject? {
        if (started != false) return null
        val row = openItems?.obj("startRequest") ?: return null
        return row.takeIf { request(it) != null }
    }
    enum class Standing { LIVE, GONE, UNREAD }
    /** Where the card drawn for request `itemId` stands, from the reads alone. */
    fun standing(itemId: String, request: Request, openItems: JsonObject?, confirmation: JsonObject?, started: Boolean?): Standing {
        val digest = confirmation?.obj("currentVersion")?.text("digest")
        if (openItems == null || digest == null || started == null) return Standing.UNREAD
        val live = live(openItems, started)
        return if (live?.text("itemId") == itemId && digest == request.criteriaDigest) Standing.LIVE else Standing.GONE
    }
    fun staleExplanation(standing: Standing) = when (standing) { Standing.LIVE -> null; Standing.GONE -> requestGone; Standing.UNREAD -> unreadSeal }
    /** A card whose request no longer stands stays on screen, dimmed, and is not pointed at. */
    fun isOpen(standing: Standing) = standing != Standing.GONE
}

object RunSettings {
    const val tasksLandOn = "Tasks land on"
    const val lineProjectBranch = "A project branch"
    const val lineProjectBranchHint = "Recommended when tasks depend on each other: they land here first and are checked together."
    const val lineMain = "Directly into main"
    const val lineMainHint = "For a single task or an urgent fix. Every merge into main asks you."
    const val automatic = "Automatic"
    const val automaticHintProjectBranch = "The coordinator runs it for you: it decides when each task is done, handles conflicts and " +
        "failed checks, and merges the branch into main once the merge check passes — with a " +
        "receipt you can revert. The criteria and anything irreversible stay yours."
    const val automaticHintMain = "The coordinator runs it for you: it decides when each task is done and handles conflicts " +
        "and failed checks. Merging into main always asks you — a project that lands directly on " +
        "main never merges by itself. The criteria and anything irreversible stay yours."
    /** The start card's one sentence under the switch, for the line and merge check chosen (`automaticSays`). */
    const val automaticOnChecked = "The coordinator decides when each task is done and merges into main once the merge check " +
        "passes — with a receipt you can revert."
    const val automaticOnUnchecked = "The coordinator decides when each task is done and merges into main by itself — with a " +
        "receipt you can revert."
    const val automaticOnMain = "The coordinator decides when each task is done. Each merge into main still asks you."
    const val automaticOff = "You decide when each task is done and when the branch goes into main."
    const val automaticOffMain = "You decide when each task is done, and each merge into main asks you."
    fun automaticSays(automatic: Boolean, line: String, hasMergeCheck: Boolean) = when {
        !automatic -> if (line == "MAIN") automaticOffMain else automaticOff
        line == "MAIN" -> automaticOnMain
        else -> if (hasMergeCheck) automaticOnChecked else automaticOnUnchecked
    }
    /** The start card's merge check row, folded to its value, and what an empty one means. */
    const val mergeCheckSet = "Set"
    const val mergeCheckNone = "None"
    const val mergeCheckNoneSays = "Work lands once it rebases cleanly."
    const val atMost = "At most"
    const val mergeCheck = "Merge check"
    const val mergeCheckHint = "Runs on the combined tree before anything lands — on the project branch and again before main."
    const val mergeCheckPlaceholder = "No check — work lands once it rebases cleanly"
    const val noMergeCheckWarning = "No merge check: with Automatic on, the branch merges into main with nothing run on the combined tree."
    const val appliesFromNextTask = "applies from the next task"
    const val escalateAfter = "Escalate after"
    const val escalateHint = "Items the coordinator hasn’t handled by then come to you."
    const val save = "Save"
    const val notSaved = "These settings were not saved"
    const val pause = "Pause project"
    const val pauseHint = "Stops new tasks, wake-ups and merges into main. Running tasks finish."
    const val resume = "Resume project"
    const val notPaused = "The project was not paused"
    const val notResumed = "The project was not resumed"
    const val notLoaded = "How it runs could not be loaded"
    const val lineDecidedAtStart = "decided when you start"
    const val lineSuggested = "the coordinator suggests"
    fun automaticHint(line: String?) = if (line == "MAIN") automaticHintMain else automaticHintProjectBranch
    fun tasksAtATime(count: Int?) = "${if (count == 1) "task" else "tasks"} at a time"
    fun mergeCheckMissing(line: String?, automatic: Boolean, mergeCheckCommand: String?) =
        automatic && line == "PROJECT_BRANCH" && mergeCheckCommand.orEmpty().isBlank()
    fun shortBranch(ref: String): String {
        val name = ref.removePrefix("refs/heads/")
        if (!name.startsWith("project/")) return name
        val id = name.removePrefix("project/")
        if (id.length < 6 || id.any { it == '\n' || it == '\r' }) return name
        return "project/${id.take(5)}…"
    }
    fun lineInSentence(line: String?) = if (line == "MAIN") "directly into main" else "a project branch"
    fun undecidedLine(suggested: String?): String {
        val decided = "$tasksLandOn: $lineDecidedAtStart"
        if (suggested != "MAIN" && suggested != "PROJECT_BRANCH") return decided
        return "$decided — $lineSuggested ${lineInSentence(suggested)}"
    }
    fun lineLocked(since: String?) = "This project started integrating${since?.let { " $it" } ?: ""}, so the line it lands on can " +
        "no longer change. Merge it into main, or give up the branch, to start another."
    fun pauseFootnote(pausedAt: String?, now: Instant): String {
        val since = pausedAt?.let { SharePanelCopy.ago(it, now) } ?: return pauseHint
        return "Paused $since. $pauseHint"
    }
    val escalationChoices = listOf(1800 to "30 minutes", 3600 to "1 hour", 7200 to "2 hours", 14400 to "4 hours", 28800 to "8 hours", 86400 to "24 hours")
    fun escalationLabel(seconds: Int): String {
        escalationChoices.firstOrNull { it.first == seconds }?.let { return it.second }
        if (seconds % 3600 == 0) { val hours = seconds / 3600; return "$hours hour${if (hours == 1) "" else "s"}" }
        val minutes = (seconds / 60.0).roundToInt()
        return "$minutes minute${if (minutes == 1) "" else "s"}"
    }
    fun escalationOptions(current: Int) = if (escalationChoices.any { it.first == current }) escalationChoices else escalationChoices + (current to escalationLabel(current))
    /** One control, one write; null when nothing would change. */
    fun lineWrite(view: JsonObject, to: String): JsonObject? =
        if (view.flag("locked") || to == view.text("line")) null else buildJsonObject { put("line", to) }
    fun mergeCheckWrite(view: JsonObject, to: String): JsonObject? {
        val next = to.trim().ifEmpty { null }
        if (next == view.text("mergeCheckCommand")) return null
        return buildJsonObject { put("mergeCheckCommand", next?.let(::JsonPrimitive) ?: JsonNull) }
    }
    fun escalationWrite(view: JsonObject, to: Int): JsonObject? =
        if (to == view.number("escalationSeconds")) null else buildJsonObject { put("exceptionEscalationSeconds", to) }
    /** Automatic and concurrency go out under the revision the page read; the server refuses a stale one. */
    fun authorization(doc: JsonObject, automatic: Boolean? = null, maxConcurrentTasks: Int? = null): JsonObject? {
        val revision = doc.text("configRevision") ?: return null
        return buildJsonObject {
            automatic?.let { put("automatic", it) }
            maxConcurrentTasks?.let { put("maxConcurrentTasks", it) }
            put("expectedConfigRevision", revision)
        }
    }
}

/** Copy as Markdown for a project (`ShareMarkdown.project`). */
object ProjectMarkdown {
    val landingWords = mapOf("LANDED" to "on main", "ON_INTEGRATION_LINE" to "on the project branch · not on main yet", "UNKNOWN" to "no merge receipt either way")
    fun statusWord(status: String) = when (status) { "OPEN" -> "Open"; "DONE" -> "Completed"; "CANCELLED" -> "Cancelled"; else -> status }
    fun taskStatusLabel(status: String, running: Boolean) = if (running) "Running" else when (status) {
        "DONE" -> "Done"; "IN_PROGRESS" -> "In progress"; "OPEN" -> "Open"; "FAILED" -> "Failed"; "CANCELLED" -> "Cancelled"; else -> status
    }
    fun project(doc: JsonObject, link: String, buckets: JsonObject?, tasks: List<JsonObject>?): String {
        val count = ProjectDoc.taskCount(doc)
        val status = mutableListOf(statusWord(ProjectDoc.status(doc)), "$count task${if (count == 1) "" else "s"}")
        buckets?.let { b ->
            val lanes = listOf("done" to "done", "running" to "running", "ready" to "ready", "blocked" to "waiting",
                "awaitingVerification" to "awaiting verification", "failed" to "failed", "cancelled" to "cancelled")
            val progress = lanes.mapNotNull { (key, word) -> (b.number(key) ?: 0).takeIf { it > 0 }?.let { "$it $word" } }.joinToString(", ")
            if (progress.isNotEmpty()) status += progress
        }
        val out = mutableListOf("# ${doc.text("title").orEmpty()}", "", "**Status:** ${status.joinToString(" · ")}", "**Link:** $link")
        val goal = doc.text("goal")?.trim().orEmpty()
        out += listOf("", "## Goal", "", goal.ifEmpty { "No goal set" })
        out += listOf("", "## Acceptance criteria", "")
        val criteria = doc.objects("acceptanceCriteriaItems")
        if (criteria.isEmpty()) out += ProjectPage.noCriteria
        criteria.forEach { criterion ->
            var answer = ""
            when (ProjectDoc.satisfied(criterion)) {
                true -> { answer = " — Met by its work"; criterion.text("landing")?.takeIf { it.isNotEmpty() }?.let { answer += " · ${landingWords[it] ?: it}" } }
                false -> answer = " — Not met by its work"
                null -> {}
            }
            out += "${criterion.number("ordinal") ?: 0}. ${criterion.text("text")?.trim().orEmpty()}$answer"
        }
        tasks?.let {
            out += listOf("", "## Tasks", "")
            if (it.isEmpty()) out += "No top-level tasks yet"
            it.forEach { task -> out += "- ${task.text("title").orEmpty()} — ${taskStatusLabel(task.text("status").orEmpty(), task.text("workState") == "RUNNING")}" }
        }
        return out.joinToString("\n") + "\n"
    }
}
