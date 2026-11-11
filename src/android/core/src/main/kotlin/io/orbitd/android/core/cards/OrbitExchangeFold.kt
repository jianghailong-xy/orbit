package io.orbitd.android.core.cards

import io.orbitd.android.core.realtime.RunEvent
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * A turn Orbit opened in a conversation — a fact told to a coordinator, a watch or a background job coming back, another session's
 * reply — together with everything the agent did and said under it, folded into one line (web `lib/orbitExchangeFold.ts` and
 * `components/OrbitExchangeFold.tsx`, design docs/mocks/coordinator-exchange-fold/, approved 2026-11-11):
 *
 *     → Evidence revision 2 submitted: B1 — 我确认了 B1… · 5:14 PM                one exchange
 *     ⋯ 7 Orbit updates handled · 3 evidence, 2 watches · 5:14 PM – 6:49 PM      two or more in a row, opening by task
 *
 * A coordinator spends most of its turns on these: in one real coordinator, 260 of 555 turns were Orbit's, and the reply under a
 * watch's turn was a median 155 characters saying nothing needed doing. Folded, each says what happened and how the agent answered
 * it, and opens back to exactly what was drawn before. The words are the web's, held to it by `OrbitExchangeFoldCopyParityTest`.
 */
object OrbitExchangeFold {
    const val otherBranch = "Not about a task"
    fun handled(n: Int) = "$n Orbit updates handled"
    fun updates(n: Int) = "$n ${if (n == 1) "update" else "updates"}"
    fun downstream(n: Int) = "$n downstream"
    fun last(reply: String) = "last: $reply"
    fun replyFrom(title: String) = "Reply from $title"

    /** How a group counts what it holds, by kind, in this order: (category, one, many) — web `CATEGORY_WORDS`. */
    val categoryWords = listOf(
        Triple("evidence", "evidence", "evidence"),
        Triple("ready", "can start", "can start"),
        Triple("project", "project update", "project updates"),
        Triple("watch", "watch", "watches"),
        Triple("job", "background job", "background jobs"),
        Triple("reply", "reply", "replies"),
    )

    /** Facts a coordinator is told that are bad news: they stay in view, as they always were drawn (web `LOUD_DELIVERIES`). */
    val loudDeliveries = setOf("TASK_DISPATCH_REFUSED", "PROJECT_BLOCKER_RAISED", "TASK_RUN_STOPPED")

    /** The cards a turn can carry that are never folded: somebody's words, an item to act on, a run's or a project's start, a review. */
    private val keptCards = listOf("sessionMessage", "openItemDelivery", "ownerAnswer", "taskStart", "projectStarted",
        "confirmationReviewRequest", "confirmationReturn")

    /** What an exchange is about, as far as a tree can place it: `TASK` or `SESSION`. */
    data class Target(val kind: String, val id: String, val title: String? = null)

    /** What a turn's opening event says happened, read by [turnOf]. */
    data class Head(val what: String, val whatInTask: String?, val category: String, val target: Target?)

    /** One folded exchange: where it starts and ends, when, what happened, and the first line of the agent's answer. */
    data class Summary(val seq: Long, val lastSeq: Long, val ts: String?, val what: String, val whatInTask: String?, val reply: String,
        val category: String, val target: Target?)

    /**
     * What a turn's opening event says happened, when Orbit opened the turn and it is one the reader can be spared: a fact told to a
     * coordinator, a watch or a background job coming back, another session's reply. Null for everything else, and for those that
     * went wrong — a refused start, a blocker, a stopped run, a failed target or job, a delivery nobody confirmed — which stay drawn
     * (web `orbitTurnOf`). [wakeName] names a watch's target the way the wake's own line does.
     */
    fun turnOf(event: RunEvent, wakeName: (String, JsonObject) -> String? = { _, _ -> null }): Head? {
        if (event.type != "user") return null
        val payload = event.fields
        if (payload["steer"] == JsonPrimitive(true)) return null
        if (payload.text("delivery") in setOf("failed", "unconfirmed")) return null
        if (keptCards.any { payload[it] is JsonObject }) return null
        val replies = payload.objects("sessionReplies")
        if (replies.isNotEmpty()) {
            val reply = replies.singleOrNull() ?: return null
            if (personWords(payload).isNotBlank()) return null
            val from = reply.text("fromSessionId")?.takeIf { it.isNotEmpty() } ?: return null
            val title = reply.text("fromTitle").orEmpty()
            return Head(replyFrom(title), null, "reply", Target("SESSION", from, title))
        }
        payload.obj("coordinatorDelivery")?.let(CoordinatorDeliveryLine::parse)?.let { card ->
            if (card.kind in loudDeliveries) return null
            val what = CoordinatorDeliveryLine.sentence(card)
            val category = when {
                card.kind.startsWith("EVIDENCE_") -> "evidence"
                card.kind == "DEPENDENT_READY" -> "ready"
                else -> "project"
            }
            return Head(what, card.task?.let { what.replace(": ${it.title}", "") }, category,
                card.task?.let { Target("TASK", it.id, it.title) })
        }
        watchWake(payload.text("text").orEmpty())?.let { wake ->
            if (WatchWakeCard.isFailed(wake)) return null
            val changed = wake.objects("changedTargets")
            val one = changed.singleOrNull()
            val watchId = wake.text("watchId").orEmpty()
            val name = one?.let { wakeName(watchId, it) }?.takeIf { it.isNotEmpty() }
            val title = WatchWakeCard.title(wake.text("state"))
            val kind = one?.text("kind")
            val target = if (one != null && kind in setOf("TASK", "SESSION")) one.text("id")?.let { Target(kind!!, it, name) } else null
            return Head(if (name != null) "$title: $name" else title, title, "watch", target)
        }
        backgroundWake(payload.text("controlPlaneNote").orEmpty())?.let { wake ->
            if (BackgroundWakeCard.jobs(wake).any(BackgroundWakeCard::isFailed)) return null
            val title = BackgroundWakeCard.title(wake)
            val name = BackgroundWakeCard.lineName(wake)?.takeIf { it.isNotEmpty() }
            return Head(if (name != null) "$title: $name" else title, null, "job", null)
        }
        return null
    }

    /** The words a person typed: the echo without what delivery appended to it. */
    private fun personWords(payload: JsonObject): String {
        val text = payload.text("text").orEmpty()
        val note = payload.text("controlPlaneNote")
        return if (note != null && note.isNotBlank() && text.endsWith(note)) text.dropLast(note.length) else text
    }

    /** The first line a reply says, as plain text: what a folded row shows of how the agent answered (web `replyGist`). */
    fun replyGist(text: String): String {
        val line = text.split('\n').map { it.trim() }.firstOrNull { it.isNotEmpty() && !Regex("^(```|---|\\|)").containsMatchIn(it) }.orEmpty()
        return line
            .replace(Regex("!?\\[([^\\]]*)\\]\\([^)]*\\)"), "$1")
            .replaceFirst(Regex("^(#{1,6}\\s+|>\\s*|[-*+]\\s+|\\d+[.)]\\s+)"), "")
            .replace(Regex("(\\*\\*|__|`)"), "")
            .trim()
    }

    /** What a group holds, counted by kind: "3 evidence, 1 can start, 2 watches" (web `exchangeKinds`). */
    fun kinds(categories: List<String>): String = categoryWords.mapNotNull { (category, one, many) ->
        val n = categories.count { it == category }
        if (n > 0) "$n ${if (n == 1) one else many}" else null
    }.joinToString(", ")

    /**
     * What the app knows that places an exchange in the tree: which task a session runs, which tasks a task waits on, a task's title,
     * and how ids compare whichever way each is spelled. Each answers nothing it does not know.
     */
    interface Lookup {
        fun taskOfSession(sessionId: String): Pair<String, String?>? = null
        fun upstreamOf(taskId: String): List<String> = emptyList()
        fun taskTitle(taskId: String): String? = null
        fun key(id: String): String = id
    }

    object NoLookup : Lookup

    /** A task in a group's tree: [key] is unique in the tree — the task's id, `session:<id>`, or `other`. */
    class Branch<E>(val key: String, val taskId: String?, var title: String, val exchanges: MutableList<E> = mutableListOf(),
        val children: MutableList<Branch<E>> = mutableListOf())

    /**
     * A group's exchanges as a tree of the tasks they are about (web `buildExchangeTree`): each exchange under its task, and a task
     * under the task it waits on when that task is in the same group too (the first one to appear, when it waits on several). A task
     * whose prerequisites are not in the group is a root; a session no task is known to run is a branch of its own; exchanges about
     * no task gather in one branch, last. Null when the group is about one thing only.
     */
    fun <E> tree(exchanges: List<E>, target: (E) -> Target?, lookup: Lookup): List<Branch<E>>? {
        val branches = LinkedHashMap<String, Branch<E>>()
        val other = mutableListOf<E>()
        exchanges.forEach { ex ->
            val t = target(ex)
            val task = when (t?.kind) {
                "TASK" -> t.id to t.title
                "SESSION" -> lookup.taskOfSession(t.id)
                else -> null
            }
            val placed = task ?: t?.takeIf { it.kind == "SESSION" }?.let { it.id to it.title }
            if (placed == null) { other += ex; return@forEach }
            val key = if (task != null) lookup.key(task.first) else "session:${lookup.key(placed.first)}"
            val branch = branches.getOrPut(key) {
                Branch(key, task?.first, (if (task != null) task.second ?: lookup.taskTitle(task.first) else placed.second).orEmpty())
            }
            if (branch.title.isEmpty() && !placed.second.isNullOrEmpty()) branch.title = placed.second!!
            branch.exchanges += ex
        }
        if (branches.size + (if (other.isEmpty()) 0 else 1) < 2) return null
        val order = branches.keys.toList()
        val roots = mutableListOf<Branch<E>>()
        order.forEach { key ->
            val branch = branches.getValue(key)
            if (branch.title.isEmpty()) {
                val id = branch.taskId ?: key.removePrefix("session:")
                branch.title = "${if (branch.taskId != null) "Task" else "Session"} ${lookup.key(id).takeLast(8)}"
            }
            val prerequisites = branch.taskId?.let { lookup.upstreamOf(it).map(lookup::key) }.orEmpty()
            val up = order.filter { it != key && it in prerequisites }.firstOrNull { !isBelow(branches.getValue(it), branch) }
            if (up != null) branches.getValue(up).children += branch else roots += branch
        }
        if (other.isNotEmpty()) roots += Branch("other", null, otherBranch, other)
        return roots
    }

    private fun <E> isBelow(candidate: Branch<E>, branch: Branch<E>): Boolean =
        branch.children.any { it === candidate || isBelow(candidate, it) }

    /** Every exchange a branch holds, its own and its descendants', in conversation order. */
    fun <E> all(branch: Branch<E>, seq: (E) -> Long): List<E> {
        val out = mutableListOf<E>()
        fun walk(b: Branch<E>) { out += b.exchanges; b.children.forEach(::walk) }
        walk(branch)
        return out.sortedBy(seq)
    }

    /** How many tasks sit below a branch, at any depth. */
    fun <E> downstreamCount(branch: Branch<E>): Int = branch.children.sumOf { 1 + downstreamCount(it) }

    /**
     * Which tasks each task waits on, and each task's title, read off a project's dependency graph (web `upstreamFromGraph`): a straight
     * run is one mark whose members wait on each other in order, and an edge between marks joins the last task of the one to the first
     * of the other. A motif stands for many instances, so it places nothing.
     */
    fun upstreamFromGraph(graph: JsonObject?, key: (String) -> String = { it }): Pair<(String) -> List<String>, (String) -> String?> {
        val up = HashMap<String, MutableList<String>>()
        val titles = HashMap<String, String>()
        val first = HashMap<String, String>()
        val last = HashMap<String, String>()
        graph?.objects("marks")?.forEach { mark ->
            val id = mark.text("id") ?: return@forEach
            when (mark.text("kind")) {
                "TASK" -> mark.text("taskId")?.let { task ->
                    mark.text("title")?.let { titles[key(task)] = it }
                    first[id] = task; last[id] = task
                }
                "RUN", "SETTLED" -> {
                    val members = mark.objects("members").filter { it.text("taskId") != null }
                    members.forEachIndexed { i, m ->
                        val task = m.text("taskId")!!
                        m.text("title")?.let { titles[key(task)] = it }
                        if (mark.text("kind") == "RUN" && i > 0) up.getOrPut(key(task)) { mutableListOf() } += members[i - 1].text("taskId")!!
                    }
                    if (members.isNotEmpty()) { first[id] = members.first().text("taskId")!!; last[id] = members.last().text("taskId")!! }
                }
            }
        }
        graph?.objects("edges")?.forEach { edge ->
            val from = edge.text("sourceMarkId")?.let(last::get)
            val to = edge.text("targetMarkId")?.let(first::get)
            if (from != null && to != null) up.getOrPut(key(to)) { mutableListOf() } += from
        }
        return { task: String -> up[key(task)].orEmpty() } to { task: String -> titles[key(task)] }
    }
}
