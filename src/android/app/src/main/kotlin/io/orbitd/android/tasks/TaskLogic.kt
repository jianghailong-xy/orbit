package io.orbitd.android.tasks

import io.orbitd.android.core.cards.*
import io.orbitd.android.core.net.ApiError
import io.orbitd.android.navigation.ObjectId
import kotlinx.serialization.json.*
import java.text.NumberFormat
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

// The pinned OrbitKit rules and words the iOS Tasks pages draw by (App/TaskListLogic.swift,
// TaskListCopy.swift, TaskDetailPage.swift, TaskReopen.swift, TaskRunHandoff.swift,
// TaskJudgment.swift, OwnerConfirmation.swift). Pure functions over the server's own JSON rows, so
// TaskCopyParityTest can hold every string to the Swift source and every rule is unit tested.

private fun count(n: Int, locale: Locale = Locale.getDefault()): String = NumberFormat.getIntegerInstance(locale).format(n)

object TaskListCopy {
    const val allTasks = "All tasks"
    const val noList = "No list"
    const val taskListsTitle = "Task Lists"
    const val searchLists = "Search lists"
    const val scopeNoteLead = "Tasks outside projects."
    fun scopeNoteTail(projects: Int) = "tasks in ${count(projects)} projects are on their project pages."
    const val projectsLink = "Projects ›"
    const val steeringSession = "Steering session ›"
    const val happeningNow = "Happening now"
    fun restHeader(sort: TaskSort, descending: Boolean) = when (sort) {
        TaskSort.CREATED -> if (descending) "Newest first" else "Oldest first"
        TaskSort.STATUS -> "By status"
        TaskSort.TITLE -> "By title"
        TaskSort.ASSIGNEE -> "By assignee"
    }
    const val prerequisiteCancelled = "Prerequisite cancelled — resolve it"
    const val waitingForPrerequisites = "Waiting for prerequisites"
    const val startsPrefix = "Starts "
    const val unassigned = "Unassigned"
    const val selectTasks = "Select Tasks"
    const val viewAs = "View as"
    const val tasksView = "Tasks"
    const val batchesView = "Batches"
    const val groupedByLabel = "Grouped by label"
    const val sortBy = "Sort By"
    const val filterByLabel = "Filter by Label…"
    const val searchTasks = "Search tasks"
    const val searchLabels = "Search labels"
    const val labelsTitle = "Labels"
    const val clearLabels = "Clear"
    const val byLabel = "by label"
    fun left(n: Int) = if (n == 0) "All done" else "${count(n)} left"
    fun showingLargest(shown: Int, total: Int) = "Showing the ${count(shown)} largest of ${count(total)} labels."
    fun selected(n: Int) = "${count(n)} selected"
    const val selectAll = "Select All"
    const val deselectAll = "Deselect All"
    const val run = "Run"
    const val stop = "Stop"
    const val setAssignee = "Set assignee"
    const val delete = "Delete"
    const val noneReady = "No tasks are ready to run."
    const val noneRunning = "No tasks are running."
    const val noneInList = "No tasks in this list yet."
    const val noneUnlisted = "No tasks without a list yet."
    const val noneYet = "No tasks yet."
    fun noneMatch(query: String) = "No tasks match “$query”."
    const val noLabels = "No labels here yet. Agents add them when they file a task."
    // TasksView.swift's own sentences.
    const val deleteTitle = "Delete this task?"
    const val deleteMessage = "This can't be undone. Finished run sessions are kept; a run still in flight is stopped."
    const val loadFailed = "Tasks couldn't be loaded"
    const val loadMore = "Load more"
    const val loading = "Loading…"
    fun batchTitle(action: TaskBatchAction, n: Int) = when (action) {
        TaskBatchAction.RUN -> "Run $n selected task${if (n == 1) "" else "s"}?"
        TaskBatchAction.STOP -> "Stop selected tasks?"
        TaskBatchAction.ASSIGN -> setAssignee
        TaskBatchAction.DELETE -> "Delete $n selected task${if (n == 1) "" else "s"}?"
    }
    fun batchMessage(action: TaskBatchAction, n: Int) = when (action) {
        TaskBatchAction.RUN -> "At most ${batchConcurrency(n)} run at once; the rest queue and start as slots free up."
        TaskBatchAction.STOP -> "Cancels each selected task's running or queued run."
        TaskBatchAction.ASSIGN -> "Set the assignee (responsible workspace) for $n selected task(s)."
        TaskBatchAction.DELETE -> "Runs still in flight are stopped. This action cannot be undone."
    }
    /** The web's default for one batch: a few at once, never more than the batch. */
    fun batchConcurrency(n: Int) = maxOf(1, minOf(n, 3))
    const val noMatchingLists = "No Matching Lists"
    fun noListMatches(query: String) = "No task list matches “$query”."
}

enum class TaskBatchAction { RUN, STOP, ASSIGN, DELETE }

enum class TaskFilter(val wire: String?, val title: String) {
    RUNNABLE("RUNNABLE", "Ready"), ALL(null, "All"), RUNNING("RUNNING", "Running"), ONGOING("ONGOING", "Open"),
    FAILED("FAILED", "Failed"), DONE("DONE", "Done"), CANCELLED("CANCELLED", "Cancelled");
    companion object { fun remembered(raw: String?) = entries.firstOrNull { it.name == raw } ?: ALL }
}

enum class TaskSort(val title: String) { CREATED("Created"), STATUS("Status"), TITLE("Title"), ASSIGNEE("Assignee") }

enum class PillKind { RUNNING, QUEUED, DONE, IN_PROGRESS, OPEN, FAILED, CANCELLED }
data class TaskPill(val kind: PillKind, val label: String)

/** The scope's counts before filter/search (`GET /tasks/counts`). */
data class TaskOverview(val total: Int = 0, val open: Int = 0, val inProgress: Int = 0, val done: Int = 0, val failed: Int = 0,
    val cancelled: Int = 0, val running: Int = 0, val queued: Int = 0, val runnable: Int = 0,
    val inProjectsTasks: Int? = null, val inProjectsProjects: Int? = null) {
    fun count(filter: TaskFilter) = when (filter) {
        TaskFilter.RUNNABLE -> runnable
        TaskFilter.ALL -> total
        TaskFilter.RUNNING -> running
        TaskFilter.ONGOING -> open + inProgress
        TaskFilter.FAILED -> failed
        TaskFilter.DONE -> done
        TaskFilter.CANCELLED -> cancelled
    }
    companion object {
        fun of(counts: JsonObject) = TaskOverview(counts.number("total") ?: 0, counts.number("open") ?: 0,
            counts.number("inProgress") ?: 0, counts.number("done") ?: 0, counts.number("failed") ?: 0,
            counts.number("cancelled") ?: 0, counts.number("running") ?: 0, counts.number("queued") ?: 0,
            counts.number("runnable") ?: 0, counts.obj("inProjects")?.number("tasks"), counts.obj("inProjects")?.number("projects"))
    }
}

/** What a row's second line says after its pill (`TaskRowPhrase`). */
sealed interface TaskRowPhrase {
    data object WaitingForConfirmation : TaskRowPhrase
    data object UnderReview : TaskRowPhrase
    data object PrerequisiteCancelled : TaskRowPhrase
    data object WaitingForPrerequisites : TaskRowPhrase
    data class Starts(val local: String) : TaskRowPhrase
}

/** A session ref's run state: the modern `runState`, else the raw runner status, else the legacy mix. */
fun resolvedRunState(session: JsonObject): String? {
    session.text("runState")?.takeIf { it != "UNKNOWN" && it in RUN_STATES }?.let { return it }
    session.text("status")?.let { status ->
        return when (status) {
            "PENDING" -> "QUEUED"
            "RUNNING" -> "RUNNING"
            "AWAITING_INPUT" -> "AWAITING_INPUT"
            "SUCCEEDED" -> "SUCCEEDED"
            "FAILED" -> "FAILED"
            "INTERRUPTED" -> if (session.text("endReason").isNullOrEmpty()) "INTERRUPTED" else "ENDED"
            "CANCELLED" -> "ENDED"
            else -> null
        }
    }
    return when (session.text("sessionState")) {
        "QUEUED" -> "QUEUED"; "RUNNING" -> "RUNNING"; "AWAITING_INPUT" -> "AWAITING_INPUT"; "COMPLETED" -> "SUCCEEDED"
        "FAILED" -> "FAILED"; "INTERRUPTED" -> "INTERRUPTED"; "DORMANT", "CANCELLED", "ENDED" -> "ENDED"
        else -> null
    }
}
private val RUN_STATES = setOf("QUEUED", "RUNNING", "AWAITING_INPUT", "INTERRUPTED", "SUCCEEDED", "FAILED", "ENDED")

object TaskListLogic {
    fun isRunning(task: JsonObject): Boolean = task.flag("running") ||
        task.objects("sessions").any { resolvedRunState(it) == "RUNNING" }
    fun isQueued(task: JsonObject): Boolean = !isRunning(task) &&
        (task.flag("queued") || task.objects("sessions").any { resolvedRunState(it) == "QUEUED" })
    fun isBusy(task: JsonObject) = isRunning(task) || isQueued(task)
    fun isBlocked(task: JsonObject): Boolean = task.flag("blocked") ||
        task.text("dependencyState") in setOf("BLOCKED", "BLOCKED_FAILED") ||
        task.objects("dependsOn").any { it.obj("dependsOnTask")?.text("status") != "DONE" }

    /** Web/server Ready semantics; a server `runnable` wins when the row carries it. */
    fun canStart(task: JsonObject, assigneeHasRunner: Boolean? = null): Boolean {
        if (TaskJudgment.isGateRow(task)) return false
        val runnable = task["runnable"] as? JsonPrimitive
        if (assigneeHasRunner == null && runnable?.booleanOrNull != null) return runnable.boolean
        val hasRunner = assigneeHasRunner ?: (task.obj("assignee")?.obj("runner")?.text("id") != null)
        return task.text("status") != "DONE" && hasRunner && !isBusy(task) && !isBlocked(task)
    }

    /** `projectId` sent by every read: `none` on the browsing scopes, nothing on a picked list or creator. */
    fun projectScope(listId: String?, creatorSessionId: String?): String? =
        if (creatorSessionId != null) null else if (listId == null || listId == "none") "none" else null

    fun isProjectOnlyList(list: JsonObject): Boolean {
        val outside = list.number("tasksOutsideProjects") ?: return false
        return taskCount(list) > 0 && outside == 0
    }
    fun taskCount(list: JsonObject) = list.obj("_count")?.number("tasks") ?: 0
    fun listIsCompleted(list: JsonObject) = list.flag("completed") && (list.number("runningTasks") ?: 0) == 0

    fun rowPhrase(task: JsonObject, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): TaskRowPhrase? {
        if (task.flag("awaitingOwnerConfirmation")) return TaskRowPhrase.WaitingForConfirmation
        if (task.flag("confirmationUnderReview")) return TaskRowPhrase.UnderReview
        if (isBlocked(task)) return if (task.text("dependencyState") == "BLOCKED_FAILED") TaskRowPhrase.PrerequisiteCancelled
            else TaskRowPhrase.WaitingForPrerequisites
        val status = task.text("status")
        if (status != "DONE" && status != "CANCELLED") {
            TaskTime.local(task.text("runAt"), zone, locale)?.let { return TaskRowPhrase.Starts(it) }
        }
        return null
    }
    fun phraseText(task: JsonObject, phrase: TaskRowPhrase?): String = when (phrase) {
        TaskRowPhrase.WaitingForConfirmation -> OwnerConfirmationCopy.waitingForConfirmation
        TaskRowPhrase.UnderReview -> OwnerConfirmationCopy.underReview
        TaskRowPhrase.PrerequisiteCancelled -> TaskListCopy.prerequisiteCancelled
        TaskRowPhrase.WaitingForPrerequisites -> TaskListCopy.waitingForPrerequisites
        is TaskRowPhrase.Starts -> TaskListCopy.startsPrefix + phrase.local
        null -> task.obj("assignee")?.text("name") ?: TaskListCopy.unassigned
    }

    /** "12m" while running, else "2h ago" since the last change. */
    fun rowTime(task: JsonObject, now: Instant = Instant.now()): String? {
        if (isRunning(task)) task.text("runningSince")?.let { since -> TaskTime.elapsed(since, now)?.let { return it } }
        val stamp = task.text("updatedAt") ?: task.text("createdAt") ?: return null
        return TaskTime.relative(stamp, now)
    }

    fun emptyTitle(listId: String?, filter: TaskFilter) = when (filter) {
        TaskFilter.RUNNABLE -> TaskListCopy.noneReady
        TaskFilter.RUNNING -> TaskListCopy.noneRunning
        else -> when (listId) { null -> TaskListCopy.noneYet; "none" -> TaskListCopy.noneUnlisted; else -> TaskListCopy.noneInList }
    }
    fun pinsHappeningNow(filter: TaskFilter, creatorSessionId: String?, labels: List<String>) =
        filter == TaskFilter.ALL && creatorSessionId == null && labels.isEmpty()
    fun availableFilters(overview: TaskOverview, current: TaskFilter): List<TaskFilter> =
        listOf(TaskFilter.ALL, TaskFilter.ONGOING, TaskFilter.RUNNABLE, TaskFilter.RUNNING, TaskFilter.FAILED, TaskFilter.DONE) +
            if (overview.cancelled > 0 || current == TaskFilter.CANCELLED) listOf(TaskFilter.CANCELLED) else emptyList()

    private fun lifecycleRank(status: String?) = when (status) { "IN_PROGRESS" -> 1; "FAILED" -> 2; "OPEN" -> 3; "DONE" -> 4; "CANCELLED" -> 5; else -> 6 }
    fun statusRank(task: JsonObject) = if (isRunning(task)) 0 else if (isQueued(task)) 1 else lifecycleRank(task.text("status")) + 1

    /** Stable sort; equal pairs keep the server's createdAt-desc order. */
    fun sorted(items: List<JsonObject>, sort: TaskSort, descending: Boolean): List<JsonObject> {
        val compare: (JsonObject, JsonObject) -> Int = when (sort) {
            TaskSort.CREATED -> { a, b -> a.text("createdAt").orEmpty().compareTo(b.text("createdAt").orEmpty()) }
            TaskSort.STATUS -> { a, b -> statusRank(a) - statusRank(b) }
            TaskSort.TITLE -> { a, b -> natural(a.text("title"), b.text("title")) }
            TaskSort.ASSIGNEE -> { a, b -> natural(a.obj("assignee")?.text("name"), b.obj("assignee")?.text("name")) }
        }
        return items.withIndex().sortedWith { a, b ->
            val c = compare(a.value, b.value).let { if (descending) -it else it }
            if (c != 0) c else a.index.compareTo(b.index)
        }.map { it.value }
    }
    /** `.numeric, .caseInsensitive`: digit runs compare by value. */
    internal fun natural(a: String?, b: String?): Int {
        val left = a.orEmpty().lowercase(); val right = b.orEmpty().lowercase()
        var i = 0; var j = 0
        while (i < left.length && j < right.length) {
            if (left[i].isDigit() && right[j].isDigit()) {
                val si = i; while (i < left.length && left[i].isDigit()) i++
                val sj = j; while (j < right.length && right[j].isDigit()) j++
                val x = left.substring(si, i).trimStart('0'); val y = right.substring(sj, j).trimStart('0')
                if (x.length != y.length) return x.length - y.length
                val c = x.compareTo(y); if (c != 0) return c
            } else {
                if (left[i] != right[j]) return left[i] - right[j]
                i++; j++
            }
        }
        return (left.length - i) - (right.length - j)
    }

    fun overlayPill(running: Boolean, queued: Boolean): TaskPill? =
        if (running) TaskPill(PillKind.RUNNING, "Running") else if (queued) TaskPill(PillKind.QUEUED, "Queued") else null
    fun pill(task: JsonObject): TaskPill = overlayPill(isRunning(task), isQueued(task)) ?: statusPill(task.text("status"))
    fun statusPill(status: String?): TaskPill = when (status) {
        "DONE" -> TaskPill(PillKind.DONE, "Done")
        "IN_PROGRESS" -> TaskPill(PillKind.IN_PROGRESS, "In progress")
        "FAILED" -> TaskPill(PillKind.FAILED, "Failed")
        "CANCELLED" -> TaskPill(PillKind.CANCELLED, "Cancelled")
        else -> TaskPill(PillKind.OPEN, "Open")
    }
}

/** Dates in the browser's words (`RelativeTime`, `TaskDetailLogic.formatted`). */
object TaskTime {
    fun parse(iso: String?): Instant? = iso?.let { runCatching { Instant.parse(it) }.getOrNull() }
    fun relative(iso: String, now: Instant = Instant.now(), zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String? {
        val date = parse(iso) ?: return null
        val diff = Duration.between(date, now).seconds.toDouble()
        return when {
            diff < 60 -> "just now"
            diff < 3600 -> "${(diff / 60).toInt()}m ago"
            diff < 86_400 -> "${(diff / 3600).toInt()}h ago"
            diff < 604_800 -> "${(diff / 86_400).toInt()}d ago"
            diff < 4 * 604_800 -> "${(diff / 604_800).toInt()}w ago"
            else -> DateTimeFormatter.ofPattern("MMM d", locale).format(date.atZone(zone))
        }
    }
    fun elapsed(iso: String, now: Instant = Instant.now()): String? {
        val date = parse(iso) ?: return null
        val diff = maxOf(0L, Duration.between(date, now).seconds)
        return when {
            diff < 60 -> "${diff}s"
            diff < 3600 -> "${diff / 60}m"
            diff < 86_400 -> "${diff / 3600}h"
            else -> "${diff / 86_400}d"
        }
    }
    /** "Sep 26, 4:48 AM": the month and day, then the locale's short time. */
    fun local(iso: String?, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String? {
        val date = parse(iso)?.atZone(zone) ?: return null
        return DateTimeFormatter.ofPattern("MMM d", locale).format(date) + ", " +
            DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(locale).format(date)
    }
}

object OwnerConfirmationCopy {
    const val confirmAction = "Confirm done"
    const val waitingForConfirmation = "Waiting for your confirmation"
    const val underReview = "Under review"
}

object TaskDetailCopy {
    const val detailsHeading = "Details"
    const val dependenciesHeading = "Dependencies"
    const val descriptionHeading = "Description"
    const val acceptanceHeading = "Acceptance"
    const val inputsHeading = "Inputs"
    const val attributionHeading = "Attribution"
    const val followedByHeading = "Followed by"
    const val runsHeading = "Runs"
    const val commentsHeading = "Comments"
    const val runNow = "Run now"
    const val assigneeLabel = "Assignee"
    const val providerLabel = "Provider"
    const val modelLabel = "Model"
    const val listLabel = "List"
    const val startAtLabel = "Start at"
    const val createdByLabel = "Created by"
    const val createdFromLabel = "Created from"
    const val createdLabel = "Created"
    const val projectCancelledNote = "The project was cancelled, so this task won’t start. Reopen the project to run it."
    const val scheduleNotSet = "Not set"
    const val saveSchedule = "Save schedule"
    const val cancelSchedule = "Cancel schedule"
    const val scheduleSaved = "Start time saved"
    const val scheduleCancelled = "Scheduled start cancelled"
    const val scheduleHintUnscheduled = "Optional, in your own time zone. The task starts once, at that time."
    const val scheduleHintUnreadable = "A start is scheduled that this control cannot read. Cancel schedule clears it, or pick a time to replace it."
    fun scheduleHint(local: String) = "Starts once, on $local, in your own time zone. Run now starts immediately and clears this scheduled start."
    const val noDependencies = "No dependencies"
    const val addPrerequisite = "Add prerequisite"
    const val autoRunWhenReady = "Auto-run when all prerequisites finish"
    const val graphView = "Graph"
    const val listView = "List"
    const val currentTask = "Current"
    const val noAdjacentRelationships = "No adjacent relationships"
    const val removePrerequisiteTitle = "Remove prerequisite?"
    const val removePrerequisiteDetail = "This task will no longer wait for this prerequisite."
    const val remove = "Remove"
    const val graphLimitReached = "Graph expansion limit reached. Some branch connections remain collapsed."
    fun dependencySummary(connected: Int, loaded: Boolean, upstream: Int, downstream: Int) =
        "$connected connected${if (loaded) " loaded" else ""} · $upstream upstream · $downstream downstream"
    fun failedPrerequisites(n: Int) = if (n == 1) "A direct prerequisite failed or was cancelled — resolve it before running."
        else "$n direct prerequisites failed or were cancelled — resolve them before running."
    fun completedPrerequisites(done: Int, total: Int) = "$done of $total direct prerequisites complete. All are required."
    fun graphSnapshotLimit(maxDepth: Int?, maxNodes: Int?, maxEdges: Int?) =
        "The initial snapshot is limited to ${maxDepth ?: 8} hops or ${maxNodes ?: 100} tasks${maxEdges?.let { " or $it relationships" } ?: ""}."
    const val showMore = "Show more"
    const val showLess = "Show less"
    const val acceptanceCriteriaLabel = "Acceptance criteria"
    const val automaticJudgementLabel = "Automatic judgement"
    const val edit = "Edit"
    const val acceptanceEmpty = "No acceptance criteria set."
    const val acceptancePairEmpty = "Not set — a person decides when this task is done."
    const val acceptanceAutomaticHint = "Filled in as a pair, the task is judged by running this command and reading its exit code — nobody has to decide by hand."
    const val acceptancePairIncomplete = "The command and the exit code that counts as done go together — fill in both."
    const val acceptanceExitCodeNotAnInteger = "The exit code has to be a whole number."
    const val acceptanceCriteriaPlaceholder = "What has to be true when this task is done"
    const val acceptanceCommandLabel = "Command"
    const val acceptanceCommandPlaceholder = "e.g. npm test -w @orbit/web"
    const val doneWhenItExits = "done when it exits"
    const val saveAcceptance = "Save acceptance"
    const val cancel = "Cancel"
    const val acceptanceSaved = "Acceptance saved"
    const val inputsHint = "Files every run of this task is given — design mocks, specs. Each run gets its own copy."
    const val addFile = "Add file"
    const val removeInputTitle = "Remove this input?"
    const val removeInputDetail = "Runs already started keep their copy."
    const val countsTowardsLabel = "Counts towards"
    const val noticedInLabel = "Noticed in"
    const val crossingLabel = "Crossing"
    const val blockedByLabel = "Blocked by"
    const val evidenceOnly = "EVIDENCE ONLY"
    const val trigger = "Trigger"
    const val notReported = "Not reported by this server build."
    const val attributionUnavailable = "Attribution boundary could not be loaded"
    val absentReason = mapOf(
        "FILED_UNDER_NO_PROJECT" to "This task is filed under no project.",
        "NO_DISCOVERY_RECORDED" to "Nothing was recorded about where this work was noticed.",
        "NO_CROSSING_DECLARED" to "No declared crossing touches this task.",
        "NOTHING_BLOCKING_ATTRIBUTION" to "Nothing is blocking where this work counts.",
    )
    val crossingStateLabel = mapOf("PENDING" to "Waiting for your answer", "APPROVED" to "Approved, not yet applied",
        "DENIED" to "Refused", "APPLIED" to "Applied")
    val crossingStateMeaning = mapOf(
        "PENDING" to "the work is not filed anywhere until you answer",
        "APPROVED" to "the writer may now file it; it has not been filed yet",
        "DENIED" to "refusing is final for this crossing — file the work yourself if you change your mind",
        "APPLIED" to "this answer has been spent; it authorises nothing further",
    )
    /** What each state means for a request to move this task (iOS 779471b97), where `crossingStateMeaning` speaks for a filing: the
     * task is already filed, so "not filed anywhere until you answer" would be false of it. */
    val moveTaskStateMeaning = mapOf(
        "PENDING" to "the task stays in its project until you answer, and confirming moves it",
        "APPROVED" to "the task has not moved: this yes was recorded without moving it",
        "DENIED" to "refusing is final for this request, and the task stays where it is",
        "APPLIED" to "the task was moved when this request was confirmed",
    )
    const val followTask = "Follow task"
    const val loadingWatches = "Loading watches…"
    const val watchesUnavailable = "Couldn’t load watches."
    const val nothingWatching = "Nothing is watching this task."
    fun endedWatches(n: Int) = "$n ended ${if (n == 1) "watch" else "watches"}"
    const val follow = "Follow"
    const val watchingLabel = "Watching"
    const val waitUntilTheTask = "Wait until the task…"
    const val thenLabel = "Then"
    const val notifyMe = "Notify me"
    const val stopWatchingAfter = "Stop watching after"
    const val followDeadlineHint = "If the condition has not held by then, the watch expires. Pausing does not stop this clock."
    const val following = "Following"
    const val followMatchedAtOnce = "Already true, so the watch triggered at once"
    const val noRuns = "No runs yet"
    const val noComments = "No comments yet"
    const val suggestedLabel = "Suggested"
    const val noSuggestion = "No suggestion"
    const val noSuggestionDetail = "Keeps the agent's model, as today"
    val modelHintDetail = mapOf(
        "S" to "Rename, copy change, version bump, mechanical edits",
        "M" to "A clear feature or fix with a known shape",
        "L" to "Unknown root cause, concurrency, cross-module, migrations, the dispatch path",
        "XL" to "Architecture, design, long unattended work",
    )
    fun coordinatorReason(reason: String) = "Coordinator: $reason"
    const val smartSelectionPlaceholder = "✦ Smart selection"
    const val defaultEffort = "default effort"
    fun wouldHavePicked(pick: String, level: String) = "✦ Smart selection would have picked $pick ($level)"
    fun why(pick: String) = "Why $pick"
    const val usageLimitNote = "a failure from a usage limit would not have moved the tier"
    // The composer's chip on a task run smart selection routed (iOS 6826eed7e, 4622c6a60): its menu's head, its note, and the way to
    // the task; what the chip's spoken name ends on while it carries the ✦.
    fun pickedBySmartSelection(tier: String) = "Picked by smart selection · tier $tier"
    const val chipPickedBySmartSelection = ", picked by smart selection"
    const val modelChangeAppliesToThisRun = "Changing the model here applies to this run only. To fix the model for every run, set it on the task."
    const val openTask = "Open task ›"
    // TasksView.swift's own words beside the copy file's.
    const val loadFailed = "Task couldn't be loaded"
    const val runDisabledBlockedFailed = "A prerequisite failed or was cancelled — resolve it first."
    const val runDisabledBlocked = "Waiting for all prerequisites to finish."
    const val runDisabledBusy = "This task is already running or queued."
    const val runDisabledUnassigned = "Assign an agent before running this task."
    const val runDisabledNoRunner = "The assigned agent isn't bound to a runner."
    const val deleteTask = "Delete task"
    const val commentPlaceholder = "Add a comment… type @Workspace to mention"
    const val untitledSession = "Untitled session"
}

object TaskReopenCopy {
    const val actionLabel = "Reopen task"
    const val modalTitle = "Reopen this task?"
    const val modalOK = "Reopen"
    const val modalBody = "Reopening puts this task back to Open and changes nothing else: " +
        "its history, its evidence, its dependencies and the project it is filed under stay as they " +
        "are. It is how an attempt that stopped is picked up again as this task, rather than as a new " +
        "one filed beside it."
    const val modalProject = "If this task serves one of its project’s acceptance criteria, " +
        "the project stops reading as done while it is open again."
    const val modalRetired = "This attempt is recorded as superseded or dropped, and " +
        "reopening clears that record — a replaced attempt cannot be run again until it is gone."
}

object TaskReopen {
    private val statuses = setOf("DONE", "CANCELLED", "FAILED")
    fun isOffered(task: JsonObject) = task.text("status") in statuses
    fun paragraphs(task: JsonObject?): List<String> = buildList {
        add(TaskReopenCopy.modalBody)
        if (!task?.text("projectId").isNullOrEmpty()) add(TaskReopenCopy.modalProject)
        if (!task?.text("terminalReason").isNullOrEmpty()) add(TaskReopenCopy.modalRetired)
    }
    /** `status: OPEN` with both retirement fields as an explicit null, in one request. */
    fun request() = buildJsonObject { put("status", "OPEN"); put("supersededByTaskId", JsonNull); put("terminalReason", JsonNull) }
}

object TaskJudgmentCopy {
    const val gateActionLabel = "Decided by its verification task"
    const val gateChip = "Gate · no work of its own"
    val completionCriterionChip = mapOf(
        "EXECUTABLE" to "Judged by · its acceptance command",
        "VERIFICATION" to "Judged by · an independent check",
        "EVIDENCE_JUDGMENT" to "Judged by · submitted evidence",
        "OWNER_CONFIRMED" to "Judged by · the account owner",
    )
    val verificationSubjectHint = mapOf(
        "MISSING" to "No verification task yet — this row has no work of its own, and nothing in the ledger points at one.",
        "PENDING" to "The verification task is filed, and has not concluded yet.",
        "RUNNING" to "The verification task is running — its conclusion decides this row.",
        "BLOCKED" to "The verification task is blocked — clear what is blocking it first.",
        "FAILED" to "The verification concluded it failed — this row will not settle.",
        "PASSED" to "The verification passed — applying the result.",
    )
    const val verifierCardHeading = "Verification task"
    const val verifierCardEntry = "View"
}

data class TaskJudgmentChip(val isGate: Boolean, val text: String)

object TaskJudgment {
    fun isGateRow(task: JsonObject) = task.text("completionPolicy") == "VERIFICATION_PASSED" &&
        (task["verifiesTaskId"] == null || task["verifiesTaskId"] is JsonNull)
    fun chip(task: JsonObject): TaskJudgmentChip? {
        if (isGateRow(task)) return TaskJudgmentChip(true, TaskJudgmentCopy.gateChip)
        return TaskJudgmentCopy.completionCriterionChip[task.text("completionCriterion")]?.let { TaskJudgmentChip(false, it) }
    }
    fun verifierPill(verifier: JsonObject): TaskPill = when (verifier.text("verdict")) {
        "PASS" -> TaskPill(PillKind.DONE, "PASS")
        "FAIL", "INCONCLUSIVE" -> TaskPill(PillKind.FAILED, "FAIL")
        else -> TaskPill(PillKind.OPEN, "Open")
    }
    fun gateHint(verificationState: String?) = TaskJudgmentCopy.verificationSubjectHint[verificationState ?: "PENDING"]
        ?: TaskJudgmentCopy.verificationSubjectHint.getValue("PENDING")
}

/** The refusal a Run or message meets when another run holds the task, read by code. */
object TaskRunHandoff {
    const val heldTitle = "A newer run has this task"
    const val heldBody = "Another run is working on this task, so this one cannot take it. Open the run that has it " +
        "and carry on there."
    const val endingTitle = "That run is stopping"
    const val endingBody = "The run working on this task is on its way out. Nothing is lost — this goes through as " +
        "soon as it lets go."
    const val pinTitle = "This task is pinned to a different provider"
    const val openTheRun = "Open the run"
    const val clearThePin = "Clear the task's pin"
    const val runEntryLabel = "Run"
    const val retryEntryLabel = "Retry"
    const val openRunEntryHint = "A run of this task is going — open it"

    enum class Kind { HELD, ENDING, PIN }
    data class Conflict(val kind: Kind, val title: String, val body: String, val sessionId: String?, val taskId: String?)

    /** Null for a code this build has no words for; the caller then shows the server's own sentence. */
    fun readConflict(error: Throwable): Conflict? {
        if (error !is ApiError || error.status != 409) return null
        val body = error.body as? JsonObject ?: return null
        fun string(key: String) = body.text(key)?.takeIf { it.isNotEmpty() }
        val session = string("conflictingSessionId")
        val task = string("taskId")
        return when (body.text("code")) {
            "TASK_ALREADY_RUNNING" -> if (body.flag("conflictingSessionEnding")) Conflict(Kind.ENDING, endingTitle, endingBody, session, task)
                else Conflict(Kind.HELD, heldTitle, heldBody, session, task)
            "TASK_RUN_PIN_CONFLICT" -> {
                val pinned = string("pinnedTo") ?: "another provider"
                val running = string("runningOn") ?: "a different one"
                Conflict(Kind.PIN, pinTitle, "This task is pinned to $pinned, and the run working on it is on " +
                    "$running. A run keeps its provider for its whole life, so $pinned starts with the next one.", session, task)
            }
            else -> null
        }
    }

    enum class EntryKind { RUN, RETRY, OPEN_RUN }
    data class Entry(val kind: EntryKind, val label: String, val sessionId: String?)
    /** The live run wins over `status`, which lags. */
    fun entry(task: JsonObject): Entry {
        val busy = task.objects("sessions").firstOrNull { it.text("status") == "RUNNING" || it.text("status") == "PENDING" }
        if (task.flag("running") || task.flag("queued") || busy != null) return Entry(EntryKind.OPEN_RUN, openTheRun, busy?.text("id"))
        return if (task.text("status") == "FAILED") Entry(EntryKind.RETRY, retryEntryLabel, null) else Entry(EntryKind.RUN, runEntryLabel, null)
    }
}

/** What a task's panel offers about its own confirmation (`OwnerConfirmations.panelAction`). */
sealed interface OwnerPanelAction {
    data class Pointer(val sessionId: String) : OwnerPanelAction
    data class UnderReview(val sessionId: String) : OwnerPanelAction
    data object Confirm : OwnerPanelAction
}

object OwnerConfirmations {
    private val confirmableStatuses = setOf("OPEN", "IN_PROGRESS")
    /** `view` null is the read not having come back: only a task with no runs may confirm then. */
    fun panelAction(view: JsonObject?, task: JsonObject): OwnerPanelAction? {
        view?.obj("waiting")?.let { waiting ->
            val session = waiting.text("sessionId") ?: return null
            return if (waiting.obj("review")?.text("state") == "UNDER_REVIEW") OwnerPanelAction.UnderReview(session)
                else OwnerPanelAction.Pointer(session)
        }
        if (view != null) {
            if (view.text("completionCriterion") != "OWNER_CONFIRMED" || view.text("status") !in confirmableStatuses) return null
            return OwnerPanelAction.Confirm
        }
        if (task.text("completionCriterion") != "OWNER_CONFIRMED" || task.text("status") !in confirmableStatuses) return null
        return if (task.objects("sessions").isEmpty()) OwnerPanelAction.Confirm else null
    }
    /** The panel's press answers no run: an explicit null `requestId`, and a CONFIRM names no review record. */
    fun panelRequest() = buildJsonObject { put("decision", "CONFIRM"); put("requestId", JsonNull); put("reviewRecordId", JsonNull) }
}

/** The two presses under a task's title (`TaskDetailActionRow`). */
data class TaskActionRow(val leading: Leading?, val trailing: Trailing?) {
    sealed interface Leading {
        data class Waiting(val sessionId: String) : Leading
        data class UnderReview(val sessionId: String) : Leading
        data object ConfirmDone : Leading
        data object Reopen : Leading
    }
    sealed interface Trailing {
        data class OpenRun(val sessionId: String?) : Trailing
        data object RunNow : Trailing
        data object Retry : Trailing
        data object Gate : Trailing
    }
    val stacked get() = (leading is Leading.Waiting || leading is Leading.UnderReview) && trailing != null
    val isEmpty get() = leading == null && trailing == null
}

data class AttributionRow(val label: String, val text: String, val absent: Boolean = false, val tags: List<String> = emptyList(),
    val notes: List<String> = emptyList(), val link: Pair<String, String>? = null)

data class DependencyRow(val node: JsonObject, val isFocus: Boolean, val relationships: String, val removable: Boolean) {
    val id get() = node.text("id").orEmpty()
}

data class AcceptanceDraft(val criteria: String = "", val command: String = "", val exitCode: String = "") {
    constructor(task: JsonObject?) : this(task?.text("acceptanceCriteria").orEmpty(), task?.text("acceptanceCommand").orEmpty(),
        (task?.get("acceptanceExpectedExitCode") as? JsonPrimitive)?.longOrNull?.toString().orEmpty())
    val problem: String? get() {
        val c = command.trim(); val e = exitCode.trim()
        if (c.isEmpty() && e.isEmpty()) return null
        if (c.isEmpty() || e.isEmpty()) return TaskDetailCopy.acceptancePairIncomplete
        return if (isWholeNumber(e)) null else TaskDetailCopy.acceptanceExitCodeNotAnInteger
    }
    private fun samePair(other: AcceptanceDraft) = command.trim() == other.command.trim() && exitCode.trim() == other.exitCode.trim()
    fun changed(from: AcceptanceDraft) = criteria.trim() != from.criteria.trim() || !samePair(from)
    fun canSave(over: AcceptanceDraft) = changed(over) && problem == null
    /** Only the fields that moved; blank clears, and the command goes with its exit code. */
    fun patch(over: AcceptanceDraft): JsonObject = buildJsonObject {
        if (criteria.trim() != over.criteria.trim()) put("acceptanceCriteria", blankToNull(criteria)?.let(::JsonPrimitive) ?: JsonNull)
        if (!samePair(over)) {
            val c = blankToNull(command)
            if (c != null) {
                put("acceptanceCommand", c)
                put("acceptanceExpectedExitCode", exitCode.trim().toIntOrNull()?.let(::JsonPrimitive) ?: JsonNull)
            } else { put("acceptanceCommand", JsonNull); put("acceptanceExpectedExitCode", JsonNull) }
        }
    }
    companion object {
        fun blankToNull(value: String) = value.takeUnless { it.isBlank() }
        fun isWholeNumber(s: String): Boolean {
            val digits = s.removePrefix("-")
            return digits.isNotEmpty() && digits.all { it in '0'..'9' } && digits.length <= 9
        }
    }
}

object TaskDetailLogic {
    fun actionRow(owner: OwnerPanelAction?, reopenable: Boolean, status: String?, gate: Boolean, entry: TaskRunHandoff.Entry): TaskActionRow {
        val leading = when (owner) {
            is OwnerPanelAction.Pointer -> TaskActionRow.Leading.Waiting(owner.sessionId)
            is OwnerPanelAction.UnderReview -> TaskActionRow.Leading.UnderReview(owner.sessionId)
            OwnerPanelAction.Confirm -> TaskActionRow.Leading.ConfirmDone
            null -> if (reopenable) TaskActionRow.Leading.Reopen else null
        }
        val trailing = when {
            status == "DONE" -> null
            !gate && entry.kind == TaskRunHandoff.EntryKind.OPEN_RUN -> TaskActionRow.Trailing.OpenRun(entry.sessionId)
            gate -> TaskActionRow.Trailing.Gate
            entry.kind == TaskRunHandoff.EntryKind.RETRY -> TaskActionRow.Trailing.Retry
            else -> TaskActionRow.Trailing.RunNow
        }
        return TaskActionRow(leading, trailing)
    }

    /** Asked first like the browser's: a gate row is not waiting on a prerequisite or a workspace. */
    fun runDisabledHint(task: JsonObject, assigneeHasRunner: Boolean): String? = when {
        TaskJudgment.isGateRow(task) -> TaskJudgment.gateHint(task.text("verificationState"))
        TaskListLogic.isBlocked(task) -> if (task.text("dependencyState") == "BLOCKED_FAILED") TaskDetailCopy.runDisabledBlockedFailed
            else TaskDetailCopy.runDisabledBlocked
        TaskListLogic.isBusy(task) -> TaskDetailCopy.runDisabledBusy
        task.obj("assignee") == null -> TaskDetailCopy.runDisabledUnassigned
        !assigneeHasRunner -> TaskDetailCopy.runDisabledNoRunner
        else -> null
    }

    fun createdFootnote(creatorName: String?, createdAt: String?, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String? {
        val time = TaskTime.local(createdAt, zone, locale)
        val who = creatorName?.takeUnless { it.isBlank() }
        return when {
            who != null && time != null -> "${TaskDetailCopy.createdByLabel} $who · $time"
            who != null -> "${TaskDetailCopy.createdByLabel} $who"
            time != null -> "${TaskDetailCopy.createdLabel} $time"
            else -> null
        }
    }
    fun scheduleValue(runAt: String?, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String {
        if (runAt.isNullOrEmpty()) return TaskDetailCopy.scheduleNotSet
        return TaskTime.local(runAt, zone, locale) ?: runAt
    }
    fun scheduleHint(runAt: String?, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String {
        if (runAt.isNullOrEmpty()) return TaskDetailCopy.scheduleHintUnscheduled
        return TaskTime.local(runAt, zone, locale)?.let(TaskDetailCopy::scheduleHint) ?: TaskDetailCopy.scheduleHintUnreadable
    }

    /** The server's component, or until it arrives (or when it could not be read) the direct edges alone. */
    fun dependencyGraph(task: JsonObject, loaded: JsonObject?): JsonObject {
        val id = task.text("id").orEmpty()
        if (loaded != null && ObjectId.same(loaded.text("focusTaskId"), id)) return loaded
        fun node(ref: JsonObject, depth: Int) = buildJsonObject {
            put("id", ref.text("id").orEmpty()); put("title", ref.text("title") ?: ref.text("id").orEmpty())
            put("status", ref.text("status") ?: "OPEN"); put("depth", depth)
        }
        val prerequisites = task.objects("dependsOn").mapNotNull { it.obj("dependsOnTask") }
        val dependents = task.objects("dependedOnBy").mapNotNull { it.obj("task") }
        return buildJsonObject {
            put("focusTaskId", id)
            putJsonArray("nodes") {
                add(node(task, 0)); prerequisites.forEach { add(node(it, 1)) }; dependents.forEach { add(node(it, 1)) }
            }
            putJsonArray("edges") {
                prerequisites.forEach { add(buildJsonObject { put("sourceTaskId", it.text("id").orEmpty()); put("targetTaskId", id) }) }
                dependents.forEach { add(buildJsonObject { put("sourceTaskId", id); put("targetTaskId", it.text("id").orEmpty()) }) }
            }
        }
    }
    fun hasDependencies(task: JsonObject) = task.objects("dependsOn").isNotEmpty() || task.objects("dependedOnBy").isNotEmpty()
    fun dependencySummary(task: JsonObject, graph: JsonObject): String? {
        if (!hasDependencies(task)) return null
        val counts = graph.obj("counts")
        return TaskDetailCopy.dependencySummary(maxOf(graph.objects("nodes").size - 1, 0), graph.flag("truncated"),
            counts?.number("upstream") ?: task.objects("dependsOn").size, counts?.number("downstream") ?: task.objects("dependedOnBy").size)
    }
    fun blockedNotice(task: JsonObject): Pair<String, Boolean>? {
        val state = task.text("dependencyState") ?: "NONE"
        if (state != "BLOCKED" && state != "BLOCKED_FAILED") return null
        val prerequisites = task.objects("dependsOn").mapNotNull { it.obj("dependsOnTask") }
        if (state == "BLOCKED_FAILED") return TaskDetailCopy.failedPrerequisites(prerequisites.count { it.text("status") in setOf("FAILED", "CANCELLED") }) to true
        return TaskDetailCopy.completedPrerequisites(prerequisites.count { it.text("status") == "DONE" }, prerequisites.size) to false
    }
    fun nodePill(node: JsonObject): TaskPill =
        TaskListLogic.overlayPill(node.flag("running"), node.flag("queued")) ?: TaskListLogic.statusPill(node.text("status"))
    fun prefersGraph(graph: JsonObject) = graph.objects("edges").isNotEmpty()
    fun dependencyRows(graph: JsonObject): List<DependencyRow> {
        val nodes = graph.objects("nodes")
        val titles = nodes.associate { it.text("id") to (it.text("title") ?: it.text("id").orEmpty()) }
        val incoming = mutableMapOf<String?, MutableList<String?>>()
        val outgoing = mutableMapOf<String?, MutableList<String?>>()
        graph.objects("edges").forEach { edge ->
            incoming.getOrPut(edge.text("targetTaskId")) { mutableListOf() }.add(edge.text("sourceTaskId"))
            outgoing.getOrPut(edge.text("sourceTaskId")) { mutableListOf() }.add(edge.text("targetTaskId"))
        }
        val focus = graph.text("focusTaskId")
        val direct = incoming[focus].orEmpty().toSet()
        return nodes.map { node ->
            val id = node.text("id")
            val needs = incoming[id].orEmpty().mapNotNull { titles[it] }.joinToString(", ")
            val unblocks = outgoing[id].orEmpty().mapNotNull { titles[it] }.joinToString(", ")
            val relationships = listOfNotNull(needs.takeIf { it.isNotEmpty() }?.let { "Depends on $it" },
                unblocks.takeIf { it.isNotEmpty() }?.let { "Required by $it" }).joinToString(" · ")
            DependencyRow(node, id == focus, relationships.ifEmpty { TaskDetailCopy.noAdjacentRelationships }, id != focus && id in direct)
        }
    }
    /** The component in the project graph's terms: every task a mark of its own. */
    fun graphMarks(graph: JsonObject): JsonObject {
        val ids = graph.objects("nodes").mapNotNull { it.text("id") }.toSet()
        return buildJsonObject {
            putJsonArray("marks") { graph.objects("nodes").forEach { node -> add(buildJsonObject {
                put("kind", "TASK"); put("id", node.text("id").orEmpty()); put("taskId", node.text("id").orEmpty())
                put("title", node.text("title") ?: node.text("id").orEmpty()); put("status", node.text("status") ?: "OPEN")
                put("running", node.flag("running")); put("queued", node.flag("queued"))
            }) } }
            putJsonArray("edges") { graph.objects("edges").filter { it.text("sourceTaskId") in ids && it.text("targetTaskId") in ids }.forEach { edge ->
                add(buildJsonObject { put("sourceMarkId", edge.text("sourceTaskId").orEmpty()); put("targetMarkId", edge.text("targetTaskId").orEmpty()) })
            } }
        }
    }
    fun truncationNotice(graph: JsonObject): String? {
        val remaining = graph.objects("collapsedGroups").filter { (it.number("hiddenCount") ?: 0) > 0 }
        if (remaining.any { !it.text("cursor").isNullOrEmpty() }) {
            val limits = graph.obj("limits")
            return TaskDetailCopy.graphSnapshotLimit(limits?.number("maxDepth"), limits?.number("maxNodes"), limits?.number("maxEdges"))
        }
        if (remaining.isNotEmpty() || graph.flag("truncatedEdges")) return TaskDetailCopy.graphLimitReached
        return null
    }

    fun folds(text: String, lines: Int = 10, characters: Int = 600) = text.length > characters || text.split("\n").size > lines
    fun humanSize(bytes: Long): String = when {
        bytes >= 1024 * 1024 -> String.format(Locale.US, "%.1f MB", bytes / (1024.0 * 1024.0))
        bytes >= 1024 -> "${Math.round(bytes / 1024.0)} KB"
        else -> "$bytes B"
    }

    fun attributionRows(view: JsonObject, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()) =
        listOf(countsTowards(view), noticedIn(view), crossing(view), blockedBy(view, zone, locale))
    private fun absent(label: String, reason: String?) =
        AttributionRow(label, reason?.let { TaskDetailCopy.absentReason[it] ?: it } ?: TaskDetailCopy.notReported, absent = true)
    private fun countsTowards(view: JsonObject): AttributionRow {
        val owning = view.obj("owning") ?: return absent(TaskDetailCopy.countsTowardsLabel, view.text("owningAbsentReason"))
        return AttributionRow(TaskDetailCopy.countsTowardsLabel, owning.text("title").orEmpty(), tags = listOfNotNull(owning.text("status")),
            link = owning.text("projectId")?.let { "project" to it })
    }
    private fun noticedIn(view: JsonObject): AttributionRow {
        val discovery = view.obj("discovery") ?: return absent(TaskDetailCopy.noticedInLabel, null)
        if (!discovery.flag("recorded")) return absent(TaskDetailCopy.noticedInLabel, discovery.text("absentReason"))
        val lines = listOfNotNull(discovery.obj("project")?.text("title"), discovery.text("triggerEvent")?.let { "${TaskDetailCopy.trigger} $it" },
            discovery.obj("task")?.let { "Task: ${it.text("title").orEmpty()}" }, discovery.obj("session")?.let { "Session: ${it.text("title") ?: "untitled"}" })
        val authority = discovery.text("authority")
        val tag = if (authority == "EVIDENCE_ONLY") TaskDetailCopy.evidenceOnly else authority.orEmpty()
        val link = discovery.obj("session")?.text("sessionId")?.let { "session" to it }
            ?: discovery.obj("task")?.text("taskId")?.let { "task" to it }
            ?: discovery.obj("project")?.text("projectId")?.let { "project" to it }
        return AttributionRow(TaskDetailCopy.noticedInLabel, lines.firstOrNull() ?: tag, tags = listOf(tag), notes = lines.drop(1), link = link)
    }
    private fun crossing(view: JsonObject): AttributionRow {
        val crossing = view.obj("crossing") ?: return absent(TaskDetailCopy.crossingLabel, view.text("crossingAbsentReason"))
        val state = crossing.text("state").orEmpty()
        val notes = buildList {
            // A request to move the task reads as a move.
            (if (crossing.text("kind") == "MOVE_TASK") TaskDetailCopy.moveTaskStateMeaning else TaskDetailCopy.crossingStateMeaning)[state]?.let(::add)
            val from = crossing.obj("from")?.text("title"); val to = crossing.obj("to")?.text("title")
            if (from != null && to != null) add("$from → $to")
            crossing.text("code")?.let { code -> add(listOfNotNull(code, crossing.text("requiredAction")).joinToString(" ")) }
        }
        return AttributionRow(TaskDetailCopy.crossingLabel, TaskDetailCopy.crossingStateLabel[state] ?: state, tags = listOf(state), notes = notes)
    }
    private fun blockedBy(view: JsonObject, zone: ZoneId, locale: Locale): AttributionRow {
        val blocker = view.obj("blocker") ?: return absent(TaskDetailCopy.blockedByLabel, view.text("blockerAbsentReason"))
        val notes = listOf("${blocker.text("code") ?: "UNKNOWN"} · owner ${blocker.text("owner").orEmpty()}") +
            listOfNotNull(TaskTime.local(blocker.text("nextCheckAt"), zone, locale)?.let { "Next checked $it" })
        return AttributionRow(TaskDetailCopy.blockedByLabel, blocker.text("requiredAction").orEmpty(), tags = listOfNotNull(blocker.text("kind")), notes = notes)
    }

    /** Watches that name this task: live ones to list, and how many ended. */
    fun followers(taskId: String, watches: List<JsonObject>): Pair<List<JsonObject>, Int> {
        val related = watches.filter { watch -> watch.objects("targets").any { it.text("targetKind") == "TASK" && ObjectId.same(it.text("targetResourceId"), taskId) } }
        val live = related.filter { it.text("state") in LIVE_WATCH_STATES }
        return live to (related.size - live.size)
    }
    private val LIVE_WATCH_STATES = setOf("ACTIVE", "PAUSED")

    val modelHintLevels = listOf("S", "M", "L", "XL")
    data class ModelHintPick(val value: String?, val label: String, val detail: String)
    fun modelHintLabel(level: String, options: List<JsonObject>): String {
        val option = options.firstOrNull { it.text("level") == level }
        return listOfNotNull(level, option?.text("label"), option?.text("effort")).filter { it.isNotEmpty() }.joinToString(" · ")
    }
    fun modelHintPicks(options: List<JsonObject>) = listOf(ModelHintPick(null, TaskDetailCopy.noSuggestion, TaskDetailCopy.noSuggestionDetail)) +
        modelHintLevels.map { ModelHintPick(it, modelHintLabel(it, options), TaskDetailCopy.modelHintDetail[it].orEmpty()) }
    fun modelHintNote(task: JsonObject): String? {
        if (task.text("modelHint").isNullOrEmpty()) return null
        return task.text("modelHintReason")?.takeIf { it.isNotEmpty() }?.let(TaskDetailCopy::coordinatorReason)
    }
    /** A tier picked by a person is their own: the coordinator's reason is cleared with it. */
    fun modelHintRequest(level: String?) = buildJsonObject { put("modelHint", level?.let(::JsonPrimitive) ?: JsonNull); put("modelHintReason", JsonNull) }

    /** The decision behind a run, when it named a tier. A route with no tier routed nothing, and with the account's switch off
     * (the default) there is none: runs read as before routing (iOS 9fb3ae6ee). */
    fun runRoute(session: JsonObject, smartSelection: Boolean): JsonObject? =
        session.obj("route")?.takeIf { smartSelection && !it.text("level").isNullOrEmpty() }
    fun routePick(route: JsonObject, modelLabel: (String) -> String) =
        listOf(route.text("model")?.let(modelLabel) ?: route.text("provider").orEmpty(), route.text("effort").orEmpty()).filter { it.isNotEmpty() }.joinToString(" · ")
    fun runModelLine(session: JsonObject, smartSelection: Boolean, modelLabel: (String) -> String): String? {
        val applied = runRoute(session, smartSelection)?.flag("applied") == true
        val ranOn = session.text("model")?.takeIf { it.isNotEmpty() } ?: if (applied) session.obj("route")?.text("model")?.takeIf { it.isNotEmpty() } else null
        ranOn ?: return null
        val ranAt = session.text("effort")?.takeIf { it.isNotEmpty() } ?: if (applied) session.obj("route")?.text("effort")?.takeIf { it.isNotEmpty() } else null
        return "${modelLabel(ranOn)} · ${ranAt ?: TaskDetailCopy.defaultEffort}"
    }
    fun routeTierTag(route: JsonObject) = "✦ ${route.text("level").orEmpty()}${if (route.flag("escalated")) " ↑" else ""}"
    fun routeWhyFooter(route: JsonObject, zone: ZoneId = ZoneId.systemDefault(), locale: Locale = Locale.getDefault()): String {
        val decided = TaskTime.local(route.text("decidedAt"), zone, locale) ?: route.text("decidedAt").orEmpty()
        return (listOf("Policy v${route.number("policyVersion") ?: 0}", "decided $decided") +
            if (route.flag("escalated")) listOf(TaskDetailCopy.usageLimitNote) else emptyList()).joinToString(" · ")
    }
    fun runLabel(session: JsonObject) = when (resolvedRunState(session)) {
        "QUEUED" -> "Queued"; "RUNNING" -> "Running"; "AWAITING_INPUT" -> "Awaiting reply"; "SUCCEEDED" -> "Succeeded"
        "FAILED" -> "Failed"; "INTERRUPTED" -> "Interrupted"; "ENDED" -> "Ended"; else -> "—"
    }
}

/** Server words first (`TasksModel.friendly`), then this end's sentence for transport/permission states. */
fun taskError(error: Throwable): String = when {
    error is ApiError && error.status == 401 -> "Session expired — sign in again."
    error is ApiError && error.messages.isNotEmpty() -> error.messages.first()
    error is ApiError && error.status == 403 -> "You don't have permission to access this task."
    error is ApiError && error.status == 404 -> "This task is no longer available."
    error is io.orbitd.android.taskprojects.FeatureWriteUncertain -> error.message.orEmpty()
    error is io.orbitd.android.taskprojects.FeatureWriteRefused -> error.message.orEmpty()
    // A refusal made on this device names itself; it is not a dropped connection.
    error is IllegalStateException && !error.message.isNullOrBlank() -> error.message.orEmpty()
    else -> "Request failed — check your connection."
}

/** Copy as Markdown for a task (`ShareMarkdown.task`): the owner's own read with the signed-in link. */
object TaskMarkdown {
    const val listedRuns = 10
    const val acceptanceEmpty = "No acceptance criteria set."
    fun outcomeLabel(status: String?, terminalReason: String? = null): String = when {
        terminalReason == "SUPERSEDED" -> "Superseded"
        terminalReason == "ABANDONED" -> "Abandoned"
        else -> when (status.orEmpty()) { "OPEN" -> "Open"; "IN_PROGRESS" -> "In progress"; "DONE" -> "Done"; "FAILED" -> "Failed"
            "CANCELLED" -> "Cancelled"; else -> status.orEmpty() }
    }
    fun supersessionNote(task: JsonObject): String? {
        if (task.text("terminalReason") == "SUPERSEDED") {
            if (task.text("supersededByTaskIdAbsentReason") == "SUCCESSOR_DELETED") return "Superseded — the task that replaced it has been deleted"
            val chain = task.objects("successorChain")
            val head = chain.lastOrNull() ?: return "Superseded by a later attempt"
            return if (chain.size == 1) "Superseded by ${head.text("title").orEmpty()}"
                else "Superseded — ${head.text("title").orEmpty()} is the live attempt, ${chain.size} replacements on"
        }
        val replaced = task.objects("supersedes")
        if (replaced.size == 1) return "Replaces ${replaced[0].text("title").orEmpty()}"
        if (replaced.size > 1) return "Replaces ${replaced.size} earlier attempts"
        return null
    }
    private fun firstSeparatorAsSpace(chip: String) = chip.replaceFirst(" · ", " ")
    fun task(task: JsonObject, link: String, time: (String?) -> String): String {
        val judged = TaskJudgmentCopy.completionCriterionChip[task.text("completionCriterion")]?.let(::firstSeparatorAsSpace)
        val status = listOfNotNull(outcomeLabel(task.text("status"), task.text("terminalReason")), judged).filter { it.isNotEmpty() }.joinToString(" · ")
        val out = mutableListOf("# ${task.text("title").orEmpty()}", "", "**Status:** $status")
        supersessionNote(task)?.let { out.add("**Outcome:** $it") }
        val acceptance = task.text("acceptanceCriteria")?.trim().orEmpty()
        out += listOf("**Link:** $link", "", "## Acceptance", "", acceptance.ifEmpty { acceptanceEmpty })
        val command = task.text("acceptanceCommand")
        val code = (task["acceptanceExpectedExitCode"] as? JsonPrimitive)?.longOrNull
        if (!command.isNullOrEmpty() && code != null) out += listOf("", "Command: `$command` — done when it exits `$code`")
        val needs = task.objects("dependsOn").mapNotNull { it.obj("dependsOnTask") }
        val unblocks = task.objects("dependedOnBy").mapNotNull { it.obj("task") }
        out += listOf("", "## Dependencies", "")
        if (needs.isEmpty() && unblocks.isEmpty()) out.add("No dependencies")
        needs.forEach { out.add("- Needs: ${it.text("title").orEmpty()} — ${outcomeLabel(it.text("status"))}") }
        unblocks.forEach { out.add("- Unblocks: ${it.text("title").orEmpty()} — ${outcomeLabel(it.text("status"))}") }
        val runs = task.objects("sessions").filter { it["deletedAt"] == null || it["deletedAt"] is JsonNull }
        out += listOf("", "## Runs", "")
        if (runs.isEmpty()) out.add("No runs yet") else out += listOf("${runs.size} run${if (runs.size == 1) "" else "s"}", "")
        runs.take(listedRuns).forEach { run ->
            val workspace = run.obj("agent")?.text("name")?.takeIf { it.isNotEmpty() }?.let { " · $it" }.orEmpty()
            out.add("- ${TaskDetailLogic.runLabel(run)} · ${time(run.text("createdAt"))}$workspace")
        }
        if (runs.size > listedRuns) out.add("- …and ${runs.size - listedRuns} earlier")
        return out.joinToString("\n") + "\n"
    }
}

/** The workspace ids a comment @-mentions by name (`mentionedAgentIDs`): `@Name` at a word start. */
fun mentionedWorkspaceIds(body: String, workspaces: List<JsonObject>): List<String> = workspaces.mapNotNull { workspace ->
    val name = workspace.text("name")?.takeIf { it.isNotEmpty() } ?: return@mapNotNull null
    val pattern = Regex("(?:^|\\s)@" + Regex.escape(name) + "(?![\\w])", RegexOption.IGNORE_CASE)
    workspace.text("id")?.takeIf { pattern.containsMatchIn(body) }
}
