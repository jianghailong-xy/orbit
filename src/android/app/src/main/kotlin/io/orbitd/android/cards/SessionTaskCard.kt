package io.orbitd.android.cards

import io.orbitd.android.core.cards.number
import io.orbitd.android.core.cards.obj
import io.orbitd.android.core.cards.objects
import io.orbitd.android.core.cards.text
import io.orbitd.android.core.cards.flag
import io.orbitd.android.navigation.ObjectId
import io.orbitd.android.watch.WatchTargetStatus
import io.orbitd.android.watch.WatchTaskPill
import kotlinx.serialization.json.JsonObject

/** A task one of this session's live watches waits on, as the Tasks card reads it (OrbitKit `SessionWatchedTask`): by the name and the
 * standing the watch carries for it, and whether a watch naming it has gone unchecked. */
internal data class SessionWatchedTask(val id: String, val title: String, val standing: WatchTargetStatus?, val stale: Boolean)

/**
 * What the session's one Tasks card draws (A08-6; iOS 516ac3389, OrbitKit `SessionTaskCard`, web `sessionTaskCard`): the tasks it
 * created and the tasks its watches wait on, one row per task. A watched task the session created marks that row — as its task or as
 * the task the row replaces, in either spelling of the id — with an eye; one created elsewhere joins as a row of its own, "elsewhere"
 * in its age's place. Watched rows first; the sentence counts the created tallies plus the watched tasks created elsewhere.
 */
internal data class SessionTaskCard(val rows: List<Row>, val running: Int, val failed: Int, val done: Int, val total: Int,
    val watching: Int, val stale: Boolean) {
    /** [elsewhere]: a watched task this session did not create — no age, `elsewhere` in its place. */
    data class Row(val id: String, val title: String, val pill: WatchTaskPill?, val createdAt: String?, val replaces: JsonObject?,
        val watched: Boolean, val stale: Boolean, val elsewhere: Boolean = false)

    /** What the collapsed row says when it names one task instead of the sentence. */
    val single: Row? get() = if (total == 1 && rows.size == 1) rows[0] else null

    companion object {
        const val title = "Tasks"
        const val elsewhere = "elsewhere"
        const val replacesPrefix = "Replaces "
        const val watchingLabel = "Watching"
        const val pageTitle = "Tasks created here"

        private fun key(id: String) = ObjectId.canonical(id) ?: id
        private fun pill(status: String?, running: Boolean, queued: Boolean) =
            WatchTaskPill.overlay(running, queued) ?: status?.let { WatchTaskPill.of(it) }

        /** Null when the session neither created nor waits on any task. */
        fun of(created: JsonObject?, watched: List<SessionWatchedTask>): SessionTaskCard? {
            val byKey = LinkedHashMap<String, SessionWatchedTask>()
            watched.forEach { task ->
                val k = key(task.id)
                // Two watches over one task: one row, orange if either has gone unchecked.
                byKey[k] = byKey[k]?.let { it.copy(stale = it.stale || task.stale) } ?: task
            }
            val claimed = mutableSetOf<String>()
            val createdRows = created?.objects("items").orEmpty().map { row ->
                val id = row.text("id").orEmpty()
                val keys = listOfNotNull(key(id), row.obj("replaces")?.text("id")?.let(::key))
                val hits = keys.filter { it in byKey }
                claimed += hits
                Row(id, row.text("title").orEmpty(), pill(row.text("status"), row.flag("running"), row.flag("queued")), row.text("createdAt"),
                    row.obj("replaces"), hits.isNotEmpty(), hits.any { byKey.getValue(it).stale })
            }
            val elsewhere = byKey.filterKeys { it !in claimed }.values.map { task ->
                Row(task.id, task.title, task.standing?.let { pill(it.status, it.running, it.queued) }, null, null, true, task.stale, elsewhere = true) to
                    task.standing
            }
            var running = created?.number("running") ?: 0
            var failed = created?.number("failed") ?: 0
            var done = created?.number("done") ?: 0
            var total = created?.number("total") ?: 0
            elsewhere.forEach { (_, standing) ->
                total += 1
                if (standing?.running == true) running += 1
                if (standing?.status == "FAILED") failed += 1 else if (standing?.status == "DONE") done += 1
            }
            if (total <= 0) return null
            val rows = createdRows.filter { it.watched } + elsewhere.map { it.first } + createdRows.filter { !it.watched }
            val marked = rows.filter { it.watched }
            return SessionTaskCard(rows, running, failed, done, total, marked.size, marked.any { it.stale })
        }
    }
}
