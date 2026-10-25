package io.orbitd.android.core.cards

import kotlinx.serialization.json.*

/** One task of a batch's preview window, as the runner sends it. */
data class BatchTask(val title: String, val ref: String? = null, val dependsOnRefs: List<String> = emptyList(),
    val dependsOnTaskIds: List<String> = emptyList())

/** One task as the review lists it (OrbitKit `BatchLevelRow`): [index] is its place in the window — and in the input's own `tasks` —
 * and [number] its place in reading order, level by level, so a prerequisite always carries the smaller number. */
data class BatchLevelRow(val index: Int, val number: Int, val title: String, val waitsOn: List<Int>, val waitsOutside: Boolean)

/** One level: the tasks whose deepest prerequisite in the window is one level up, which can therefore run in parallel. */
data class BatchLevel(val number: Int, val rows: List<BatchLevelRow>)

/** One consequence of the write and the kind it is, so a view can mark it without parsing the sentence. */
data class BatchImpactRow(val kind: Kind, val text: String) {
    enum class Kind { STARTING, WAITING, MANUAL_START, CANNOT_RUN }
    /** Before the dash: the count and what happens to it, the part a person decides on. */
    val head: String get() = text.split(" — ").first()
    /** After the dash, on its own line, capitalised; null for a sentence with no dash. */
    val reason: String? get() {
        val parts = text.split(" — ")
        if (parts.size < 2) return null
        val rest = parts.drop(1).joinToString(" — ")
        return rest.take(1).uppercase() + rest.drop(1)
    }
}

/** What a task's page in the review shows, read off the body the runner is about to send. */
data class BatchTaskDetail(val title: String, val description: String = "", val acceptanceCriteria: String = "",
    val completionCriterion: String = "", val labels: List<String> = emptyList()) {
    /** The chip the task's own page draws for how it is judged. */
    val judgedBy: String? get() = BatchReview.judgedBy[completionCriterion]
}

/**
 * The batch-create review (A08-7; iOS 96c9a964d, OrbitKit `BatchReview`/`BatchTree`): what the write does first, then the tasks — by
 * level when they wait on each other, one numbered list when they do not — every prerequisite named by its number, and each task one
 * press from a page of its own. Levels are web's layers (`buildBatchGraph`, longest path), so both clients order one batch alike.
 */
object BatchReview {
    const val waitsOn = "Waits on"
    const val outsideTask = "a task outside"
    const val andOutsideTask = "and a task outside"
    const val outsideTaskSection = "A task outside"
    const val neededBy = "Needed by"
    const val doneWhen = "Done when"
    const val descriptionHeading = "Description"

    val judgedBy = mapOf(
        "EXECUTABLE" to "Judged by · its acceptance command",
        "VERIFICATION" to "Judged by · an independent check",
        "EVIDENCE_JUDGMENT" to "Judged by · submitted evidence",
        "OWNER_CONFIRMED" to "Judged by · the account owner",
    )

    /** The preview's window of tasks: titles and wiring only, the first dozen of the batch. */
    fun tasks(preview: JsonObject?): List<BatchTask> = preview?.objects("tasks").orEmpty().map {
        BatchTask(it.text("title") ?: it.text("key") ?: "Task", it.text("ref"), it.strings("dependsOnRefs"), it.strings("dependsOnTaskIds"))
    }

    private fun refIndex(tasks: List<BatchTask>): Map<String, Int> = buildMap {
        tasks.forEachIndexed { i, task -> task.ref?.takeIf { it.isNotEmpty() }?.let { put(it, i) } }
    }

    /** Each task's level, 0-based: one below its deepest prerequisite in the window. Refs may only name earlier items, so one forward
     * pass is the whole computation; a ref naming nothing in the window is ignored. */
    fun layers(tasks: List<BatchTask>): List<Int> {
        val indexByRef = refIndex(tasks)
        val layer = IntArray(tasks.size)
        tasks.forEachIndexed { i, task ->
            task.dependsOnRefs.forEach { ref ->
                val from = indexByRef[ref] ?: return@forEach
                if (from != i) layer[i] = maxOf(layer[i], layer[from] + 1)
            }
        }
        return layer.toList()
    }

    /** The window as the review lists it: by level, numbered in reading order, every in-window prerequisite named by its number. */
    fun levels(tasks: List<BatchTask>): List<BatchLevel> {
        val layer = layers(tasks)
        val deepest = layer.maxOrNull() ?: return emptyList()
        val indexByRef = refIndex(tasks)
        val order = tasks.indices.sortedWith(compareBy({ layer[it] }, { it }))
        val number = IntArray(tasks.size)
        order.forEachIndexed { n, i -> number[i] = n + 1 }
        fun row(i: Int) = BatchLevelRow(i, number[i], tasks[i].title,
            tasks[i].dependsOnRefs.mapNotNull { indexByRef[it] }.filter { it != i }.toSet().map { number[it] }.sorted(),
            tasks[i].dependsOnTaskIds.isNotEmpty())
        return (0..deepest).map { d -> BatchLevel(d + 1, order.filter { layer[it] == d }.map(::row)) }
    }

    /** The tasks in the window that wait on [row], for its page's "Needed by". */
    fun neededBy(row: BatchLevelRow, levels: List<BatchLevel>) = levels.flatMap { it.rows }.filter { row.number in it.waitsOn }

    /** The consequence rows, in the order a person decides in; [batchImpactLines] is these sentences. */
    fun impactRows(preview: JsonObject): List<BatchImpactRow> = buildList {
        val starting = preview.number("startingNow") ?: 0
        val blocked = preview.number("blocked") ?: 0
        val manual = preview.number("needsManualStart") ?: 0
        val unavailable = preview.number("notDispatchable") ?: 0
        if (starting > 0) add(BatchImpactRow(BatchImpactRow.Kind.STARTING, "$starting start${if (starting == 1) "s" else ""} running within the minute"))
        if (blocked > 0) add(BatchImpactRow(BatchImpactRow.Kind.WAITING, "$blocked wait${if (blocked == 1) "s" else ""} on a prerequisite"))
        if (manual > 0) add(BatchImpactRow(BatchImpactRow.Kind.MANUAL_START,
            "$manual need${if (manual == 1) "s" else ""} a manual start — nothing will trigger ${if (manual == 1) "it" else "them"}"))
        if (unavailable > 0) add(BatchImpactRow(BatchImpactRow.Kind.CANNOT_RUN,
            "$unavailable cannot run — unassigned, no runner, auto-run off, or the list is paused"))
    }

    /** "3 levels, up to 2 in parallel": a one-line reading of the shape. "N in parallel after 1" is said only when one task releases
     * the rest. */
    fun shape(tasks: List<BatchTask>): String {
        if (tasks.isEmpty()) return ""
        val layer = layers(tasks)
        val depth = (layer.maxOrNull() ?: 0) + 1
        if (depth == 1) return if (tasks.size == 1) "a single task" else "${tasks.size} independent tasks"
        val counts = (0 until depth).map { d -> layer.count { it == d } }
        val widest = counts.max()
        if (widest == 1) return "a chain of ${tasks.size}"
        if (depth == 2 && counts[0] == 1) return "$widest in parallel after 1"
        return "$depth levels, up to $widest in parallel"
    }

    /** Where the batch lands and what shape it is, each part only when there is one — never opening on a separator. */
    fun detailLine(preview: JsonObject): String = buildList {
        val lists = preview.objects("lists").mapNotNull { it.text("title") }
        if (lists.isNotEmpty()) add("into ${lists.joinToString(", ")}")
        val edges = (preview.number("internalEdges") ?: 0) + (preview.number("externalEdges") ?: 0)
        if (edges > 0) add("$edges dependency edge${if (edges == 1) "" else "s"}")
        shape(tasks(preview)).takeIf { it.isNotEmpty() }?.let { add(it) }
    }.joinToString(" · ")

    /** Every task body the input carries, in the order it was sent. */
    fun details(input: JsonObject): List<BatchTaskDetail> = input.objects("tasks").map {
        BatchTaskDetail(it.text("title").orEmpty(), it.text("description").orEmpty(), it.text("acceptanceCriteria").orEmpty(),
            it.text("completionCriterion").orEmpty(), it.strings("labels"))
    }

    /** The body behind a row: the input's task at the row's own position; if the two disagree, the first body with the row's title —
     * never another task's description under this one's name. */
    fun detail(row: BatchLevelRow, details: List<BatchTaskDetail>): BatchTaskDetail? =
        details.getOrNull(row.index)?.takeIf { it.title == row.title } ?: details.firstOrNull { it.title == row.title }

    /** The yes, naming the count — the title above it scrolls away. */
    fun createAction(count: Int) = "Create $count task${if (count == 1) "" else "s"}"
    fun levelName(level: BatchLevel) = "Level ${level.number}"
    fun levelParallel(level: BatchLevel) = if (level.rows.size > 1) "${level.rows.size} in parallel" else null
    /** The page's title: its number, and out of how many when the window holds them all. */
    fun taskPageTitle(number: Int, total: Int?) = if (total != null) "Task $number of $total" else "Task $number"
    fun more(count: Int) = "+$count more"
}
