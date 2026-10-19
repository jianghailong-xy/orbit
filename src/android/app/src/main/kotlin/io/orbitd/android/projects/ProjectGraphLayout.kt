package io.orbitd.android.projects

import io.orbitd.android.core.cards.*
import kotlinx.serialization.json.*
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min

// OrbitKit `ProjectGraph` (App/ProjectGraphLayout.swift) and its mark model (Models/ProjectPlan.swift):
// the web's folds and words with a layered layout that picks the direction that fits a phone. Pure,
// so ProjectGraphLayoutTest holds it to the Swift cases.

enum class MarkKind { TASK, RUN, MOTIF, SETTLED, UNKNOWN }

data class GraphMember(val taskId: String, val title: String, val status: String, val running: Boolean = false, val queued: Boolean = false,
    val workState: String? = null, val verificationState: String? = null)

data class GraphMark(val kind: MarkKind, val id: String, val title: String, val parentTaskId: String? = null, val taskId: String? = null,
    val status: String? = null, val running: Boolean = false, val queued: Boolean = false, val workState: String? = null,
    val verificationState: String? = null, val taskCount: Int = 1, val statusCounts: Map<String, Int> = emptyMap(),
    val members: List<GraphMember> = emptyList(), val samples: List<GraphMember> = emptyList(), val expandable: Boolean = false,
    /** How the task is settled and whether Orbit starts it once ready — what the start card reads; absent from an older server. */
    val completionCriterion: String? = null, val autoRunWhenReady: Boolean? = null) {
    companion object {
        fun of(json: JsonObject): GraphMark? {
            val id = json.text("id") ?: return null
            fun member(m: JsonObject) = m.text("taskId")?.let { GraphMember(it, m.text("title").orEmpty(), m.text("status").orEmpty(), m.flag("running"),
                m.flag("queued"), m.text("workState"), m.text("verificationState")) }
            return GraphMark(MarkKind.entries.firstOrNull { it.name == json.text("kind") } ?: MarkKind.UNKNOWN, id, json.text("title").orEmpty(),
                json.text("parentTaskId"), json.text("taskId"), json.text("status"), json.flag("running"), json.flag("queued"), json.text("workState"),
                json.text("verificationState"), json.number("taskCount") ?: 1,
                json.obj("statusCounts")?.mapNotNull { (k, v) -> (v as? JsonPrimitive)?.intOrNull?.let { k to it } }?.toMap().orEmpty(),
                json.objects("members").mapNotNull(::member), json.objects("samples").mapNotNull(::member), json.flag("expandable"),
                completionCriterion = json.text("completionCriterion"), autoRunWhenReady = (json["autoRunWhenReady"] as? JsonPrimitive)?.booleanOrNull)
        }
    }
}

data class GraphEdge(val source: String, val target: String)

/** The response as the page reads it (`ProjectDependencyGraph`). */
data class DependencyGraph(val marks: List<GraphMark>, val edges: List<GraphEdge>, val taskCount: Int, val truncated: Boolean, val maxTasks: Int?) {
    companion object {
        fun of(json: JsonObject): DependencyGraph {
            val marks = json.objects("marks").mapNotNull(GraphMark::of)
            return DependencyGraph(marks, json.objects("edges").mapNotNull { e ->
                val s = e.text("sourceMarkId"); val t = e.text("targetMarkId"); if (s != null && t != null) GraphEdge(s, t) else null
            }, json.number("taskCount") ?: marks.size, json.flag("truncated"), json.obj("limits")?.number("maxTasks"))
        }
    }
}

object ProjectGraphLayout {
    enum class State { PENDING, ACTIVE, QUEUED, COMPLETE, FAILED }
    enum class Tone { READY, BLOCKED, ACTIVE, QUEUED, COMPLETE, FAILED }
    enum class Direction { LEFT_TO_RIGHT, TOP_TO_BOTTOM }

    /** Fold each connected block of finished tasks into one mark (`foldSettled`). */
    fun foldSettled(marks: List<GraphMark>, edges: List<GraphEdge>, expanded: Set<String>): Pair<List<GraphMark>, List<GraphEdge>> {
        val ids = marks.map { it.id }.toSet()
        val parents = marks.mapNotNull { it.parentTaskId?.takeIf(ids::contains) }.toSet()
        val settleable = linkedMapOf<String, GraphMark>()
        marks.filter { it.kind == MarkKind.TASK && it.status == "DONE" && !it.running && !it.queued && it.id !in parents }.forEach { settleable[it.id] = it }
        if (settleable.size < 2) return marks to edges
        val root = settleable.keys.associateWith { it }.toMutableMap()
        fun find(id: String): String {
            var at = id
            while (root[at] != null && root[at] != at) at = root.getValue(at)
            var walk = id
            while (root[walk] != null && root[walk] != at) { val up = root.getValue(walk); root[walk] = at; walk = up }
            return at
        }
        edges.forEach { edge ->
            val source = settleable[edge.source] ?: return@forEach
            val target = settleable[edge.target] ?: return@forEach
            if (source.parentTaskId != target.parentTaskId) return@forEach
            val a = find(source.id); val b = find(target.id)
            if (a != b) root[a] = b
        }
        val blocks = linkedMapOf<String, MutableList<GraphMark>>()
        settleable.keys.forEach { blocks.getOrPut(find(it)) { mutableListOf() }.add(settleable.getValue(it)) }
        val foldOf = mutableMapOf<String, String>()
        val folds = mutableMapOf<String, GraphMark>()
        blocks.values.forEach { block ->
            if (block.size < 2) return@forEach
            val members = block.sortedBy { it.id }
            val id = "settled:${members[0].id}"
            if (id in expanded) return@forEach
            members.forEach { foldOf[it.id] = id }
            folds[id] = GraphMark(MarkKind.SETTLED, id, "${members.size} done", members[0].parentTaskId, taskCount = members.size,
                statusCounts = mapOf("DONE" to members.size), members = members.map { GraphMember(it.taskId ?: it.id, it.title, it.status ?: "DONE") })
        }
        if (folds.isEmpty()) return marks to edges
        val emitted = mutableSetOf<String>()
        val folded = marks.mapNotNull { mark -> val fold = foldOf[mark.id] ?: return@mapNotNull mark; if (emitted.add(fold)) folds[fold] else null }
        val seen = mutableSetOf<GraphEdge>()
        val foldedEdges = edges.mapNotNull { edge ->
            val unit = GraphEdge(foldOf[edge.source] ?: edge.source, foldOf[edge.target] ?: edge.target)
            if (unit.source == unit.target || !seen.add(unit)) null else unit
        }
        return if (hasCycle(folded, foldedEdges)) marks to edges else folded to foldedEdges
    }

    /** Replace each opened run with its steps chained in order (`expandRuns`). */
    fun expandRuns(marks: List<GraphMark>, edges: List<GraphEdge>, expanded: Set<String>): Pair<List<GraphMark>, List<GraphEdge>> {
        val opened = marks.filter { it.kind == MarkKind.RUN && it.expandable && it.id in expanded && it.members.isNotEmpty() }.associateBy { it.id }
        if (opened.isEmpty()) return marks to edges
        val ends = mutableMapOf<String, Pair<String, String>>()
        val chain = mutableListOf<GraphEdge>()
        val result = marks.flatMap { mark ->
            val run = opened[mark.id] ?: return@flatMap listOf(mark)
            ends[run.id] = run.members.first().taskId to run.members.last().taskId
            run.members.forEachIndexed { index, member -> if (index > 0) chain += GraphEdge(run.members[index - 1].taskId, member.taskId) }
            run.members.map { GraphMark(MarkKind.TASK, it.taskId, it.title, run.parentTaskId, it.taskId, it.status, it.running, it.queued, it.workState, it.verificationState) }
        }
        return result to (edges.map { GraphEdge(ends[it.source]?.second ?: it.source, ends[it.target]?.first ?: it.target) } + chain)
    }

    /** Finished blocks folded first, then the runs the reader opened (`prepare`). */
    fun prepare(graph: DependencyGraph, expanded: Set<String>): Pair<List<GraphMark>, List<GraphEdge>> {
        val (marks, edges) = foldSettled(graph.marks, graph.edges, expanded)
        return expandRuns(marks, edges, expanded)
    }

    internal fun hasCycle(marks: List<GraphMark>, edges: List<GraphEdge>): Boolean {
        val indegree = marks.associate { it.id to 0 }.toMutableMap()
        val out = mutableMapOf<String, MutableList<String>>()
        edges.forEach { edge ->
            if (edge.source !in indegree || edge.target !in indegree) return@forEach
            indegree[edge.target] = indegree.getValue(edge.target) + 1
            out.getOrPut(edge.source) { mutableListOf() }.add(edge.target)
        }
        val ready = ArrayDeque(indegree.filterValues { it == 0 }.keys)
        var settled = 0
        while (ready.isNotEmpty()) {
            val id = ready.removeLast(); settled++
            out[id].orEmpty().forEach { next -> val left = indegree.getValue(next) - 1; indegree[next] = left; if (left == 0) ready.addLast(next) }
        }
        return settled != indegree.size
    }

    /** A fold is as done as its least done task (`state(of:)`). */
    fun state(mark: GraphMark): State {
        if (mark.kind == MarkKind.TASK) {
            val status = mark.status.orEmpty()
            if (status == "FAILED" || status == "CANCELLED") return State.FAILED
            if (status == "DONE") return State.COMPLETE
            if (mark.running || status == "IN_PROGRESS") return State.ACTIVE
            return if (mark.queued) State.QUEUED else State.PENDING
        }
        val counts = mark.statusCounts
        return when {
            (counts["FAILED"] ?: 0) > 0 -> State.FAILED
            (counts["IN_PROGRESS"] ?: 0) > 0 -> State.ACTIVE
            (counts["OPEN"] ?: 0) > 0 -> State.PENDING
            else -> State.COMPLETE
        }
    }

    /** The server's lane decides "ready" — never the graph's own indegree. */
    fun tone(mark: GraphMark): Tone = when (state(mark)) {
        State.PENDING -> if (mark.workState == "READY") Tone.READY else Tone.BLOCKED
        State.ACTIVE -> Tone.ACTIVE
        State.QUEUED -> Tone.QUEUED
        State.COMPLETE -> Tone.COMPLETE
        State.FAILED -> Tone.FAILED
    }

    /** How many of each mark's prerequisites have not released it. */
    fun waitingOn(marks: List<GraphMark>, edges: List<GraphEdge>): Map<String, Int> {
        val states = marks.associate { it.id to state(it) }
        val waiting = mutableMapOf<String, Int>()
        edges.filter { states[it.source] != State.COMPLETE }.forEach { waiting[it.target] = (waiting[it.target] ?: 0) + 1 }
        return waiting
    }

    private val statusWord = mapOf("DONE" to "Done", "IN_PROGRESS" to "In progress", "OPEN" to "Open", "FAILED" to "Failed", "CANCELLED" to "Cancelled")

    /** A task mark's one line under its title (`meta(of:waitingOn:)`). */
    fun meta(mark: GraphMark, waitingOn: Int): String {
        if (mark.workState == "AWAITING_VERIFICATION") return when (mark.verificationState) {
            "FAILED" -> "Verification failed"; "MISSING" -> "Missing verifier"; "RUNNING" -> "Awaiting verification · verifier running"
            "BLOCKED" -> "Awaiting verification · verifier blocked"; "PASSED" -> "Awaiting verification · applying result"
            else -> "Awaiting verification"
        }
        return when (tone(mark)) {
            Tone.READY -> "Ready to run"
            Tone.BLOCKED -> if (waitingOn > 0) "Waiting on $waitingOn" else "Blocked"
            else -> if (mark.running) "Running" else if (mark.queued) "Queued" else statusWord[mark.status.orEmpty()] ?: mark.status.orEmpty()
        }
    }

    fun number(value: Int): String = value.toString().reversed().chunked(3).joinToString(",").reversed()
    fun foldTitle(mark: GraphMark) = if (mark.kind == MarkKind.SETTLED) "${number(mark.taskCount)} done" else mark.title
    private val foldOrder = listOf("DONE" to "done", "IN_PROGRESS" to "running", "FAILED" to "failed", "CANCELLED" to "cancelled", "OPEN" to "open")
    fun foldLegend(mark: GraphMark): String = if (mark.kind == MarkKind.SETTLED) "Finished · tap to open"
        else foldOrder.mapNotNull { (key, word) -> (mark.statusCounts[key] ?: 0).takeIf { it > 0 }?.let { "${number(it)} $word" } }.joinToString(" · ")
    fun foldSegments(mark: GraphMark): List<Pair<String, Int>> =
        listOf("DONE", "IN_PROGRESS", "FAILED", "CANCELLED", "OPEN").mapNotNull { key -> (mark.statusCounts[key] ?: 0).takeIf { it > 0 }?.let { key to it } }
    /** A finished block always opens; a run when its steps came with it; a motif never. */
    fun canOpen(mark: GraphMark) = mark.kind == MarkKind.SETTLED || (mark.kind == MarkKind.RUN && mark.expandable && mark.members.isNotEmpty())

    /** "13 tasks · 7 ready to run · 5 done · dashed marks are folded". */
    fun summary(taskCount: Int, marks: List<GraphMark>): String {
        var ready = 0; var done = 0; var folded = 0
        marks.forEach { mark ->
            if (mark.kind != MarkKind.TASK) folded += mark.taskCount
            if (state(mark) == State.COMPLETE) done += if (mark.kind == MarkKind.TASK) 1 else mark.taskCount
            else if (mark.kind == MarkKind.TASK && mark.workState == "READY") ready += 1
        }
        return listOfNotNull("${number(taskCount)} tasks", if (ready > 0) "${number(ready)} ready to run" else null,
            if (done > 0) "${number(done)} done" else null, if (folded > 0) "dashed marks are folded" else null).joinToString(" · ")
    }
    fun truncatedNotice(maxTasks: Int?): Pair<String, String> =
        "This project is larger than one graph request reads${maxTasks?.let { " (${number(it)} tasks)" } ?: ""}." to
            "The task list below has all of them, in dependency order."

    data class Metrics(val taskWidth: Double = 172.0, val taskHeight: Double = 52.0, val foldWidth: Double = 116.0, val foldHeight: Double = 74.0,
        val rankGap: Double = 32.0, val markGap: Double = 8.0, val margin: Double = 12.0)
    data class Point(val x: Double, val y: Double)
    data class Box(val x: Double, val y: Double, val width: Double, val height: Double) {
        val midX get() = x + width / 2; val midY get() = y + height / 2; val maxX get() = x + width; val maxY get() = y + height
    }
    data class Placement(val mark: GraphMark, val box: Box)
    data class Route(val source: String, val target: String, val points: List<Point>)
    data class Layout(val direction: Direction, val width: Double, val height: Double, val placements: List<Placement>, val routes: List<Route>) {
        /** How far it has to shrink to fit, never enlarged. */
        fun fit(available: Double) = if (width <= 0) 1.0 else min(1.0, available / width)
    }

    /** Whichever direction fits `availableWidth` best, left to right when both fit. */
    fun layout(marks: List<GraphMark>, edges: List<GraphEdge>, availableWidth: Double, metrics: Metrics = Metrics()): Layout {
        val across = layout(marks, edges, Direction.LEFT_TO_RIGHT, availableWidth, metrics)
        val down = layout(marks, edges, Direction.TOP_TO_BOTTOM, availableWidth, metrics)
        return if (down.fit(availableWidth) > across.fit(availableWidth) + 0.001) down else across
    }

    /** Ranks by the longest prerequisite chain, ordered by neighbours, slots for skipped ranks, loose marks in rows after. */
    fun layout(marks: List<GraphMark>, rawEdges: List<GraphEdge>, direction: Direction, availableWidth: Double, metrics: Metrics = Metrics()): Layout {
        val unique = marks.distinctBy { it.id }
        val ids = unique.map { it.id }.toSet()
        val seen = mutableSetOf<GraphEdge>()
        val edges = rawEdges.filter { it.source != it.target && it.source in ids && it.target in ids && seen.add(it) }
        val linked = edges.flatMap { listOf(it.source, it.target) }.toSet()
        val plan = unique.filter { it.id in linked }
        val loose = unique.filter { it.id !in linked }
        fun size(mark: GraphMark) = if (mark.kind == MarkKind.TASK) metrics.taskWidth to metrics.taskHeight else metrics.foldWidth to metrics.foldHeight
        val across = direction == Direction.LEFT_TO_RIGHT

        val rank = mutableMapOf<String, Int>()
        val indegree = plan.associate { it.id to 0 }.toMutableMap()
        val out = mutableMapOf<String, MutableList<String>>()
        edges.forEach { indegree[it.target] = (indegree[it.target] ?: 0) + 1; out.getOrPut(it.source) { mutableListOf() }.add(it.target) }
        val queue = plan.map { it.id }.filter { indegree[it] == 0 }.toMutableList()
        var head = 0
        while (head < queue.size) {
            val id = queue[head++]
            val r = rank[id] ?: 0
            rank[id] = r
            out[id].orEmpty().forEach { next ->
                rank[next] = max(rank[next] ?: 0, r + 1)
                indegree[next] = (indegree[next] ?: 1) - 1
                if (indegree[next] == 0) queue.add(next)
            }
        }
        val deepest = rank.values.maxOrNull() ?: 0
        plan.forEach { if (it.id !in rank) rank[it.id] = deepest + 1 } // a cycle: never from the server

        data class Node(val mark: GraphMark?, val rank: Int)
        val nodes = mutableMapOf<String, Node>()
        val layers = MutableList((rank.values.maxOrNull() ?: -1) + 1) { mutableListOf<String>() }
        plan.forEach { mark -> val r = rank[mark.id] ?: 0; nodes[mark.id] = Node(mark, r); layers[r].add(mark.id) }
        val down = mutableMapOf<String, MutableList<String>>()
        val up = mutableMapOf<String, MutableList<String>>()
        val chains = mutableListOf<Pair<GraphEdge, List<String>>>()
        edges.forEach { edge ->
            val from = rank[edge.source] ?: 0; val to = rank[edge.target] ?: 0
            val path = mutableListOf(edge.source)
            if (to > from + 1) for (r in (from + 1) until to) {
                val slot = "·${edge.source}->${edge.target}@$r"
                nodes[slot] = Node(null, r); layers[r].add(slot); path.add(slot)
            }
            path.add(edge.target)
            path.zipWithNext().forEach { (a, b) -> down.getOrPut(a) { mutableListOf() }.add(b); up.getOrPut(b) { mutableListOf() }.add(a) }
            chains += edge to path
        }

        fun reorder(layer: List<String>, neighbours: Map<String, List<String>>, adjacent: List<String>): MutableList<String> {
            val at = mutableMapOf<String, Double>(); adjacent.forEachIndexed { i, id -> at.putIfAbsent(id, i.toDouble()) }
            return layer.mapIndexed { index, id ->
                val spots = neighbours[id].orEmpty().mapNotNull { at[it] }
                Triple(id, if (spots.isEmpty()) index.toDouble() else spots.sum() / spots.size, index)
            }.sortedWith(compareBy<Triple<String, Double, Int>> { it.second }.thenBy { it.third }).map { it.first }.toMutableList()
        }
        if (layers.size > 1) repeat(4) {
            for (r in 1 until layers.size) layers[r] = reorder(layers[r], up, layers[r - 1])
            for (r in layers.size - 2 downTo 0) layers[r] = reorder(layers[r], down, layers[r + 1])
        }

        val slotBreadth = 6.0
        fun extent(id: String): Pair<Double, Double> {
            val mark = nodes[id]?.mark ?: return 0.0 to slotBreadth
            val (w, h) = size(mark)
            return if (across) w to h else h to w
        }
        val depths = layers.map { layer -> layer.maxOfOrNull { extent(it).first } ?: 0.0 }
        val starts = mutableListOf<Double>()
        var cursor = metrics.margin
        depths.forEach { starts.add(cursor); cursor += it + metrics.rankGap }
        val planAlong = if (layers.isEmpty()) 0.0 else cursor - metrics.rankGap + metrics.margin
        val breadths = layers.map { layer -> layer.sumOf { extent(it).second } + max(0, layer.size - 1) * metrics.markGap }
        val widest = breadths.maxOrNull() ?: 0.0
        val boxes = mutableMapOf<String, Box>()
        layers.forEachIndexed { r, layer ->
            var offset = metrics.margin + (widest - breadths[r]) / 2
            layer.forEach { id ->
                val (along, breadth) = extent(id)
                val a = starts[r] + (depths[r] - along) / 2
                boxes[id] = if (across) Box(a, offset, along, breadth) else Box(offset, a, breadth, along)
                offset += breadth + metrics.markGap
            }
        }
        val planBreadth = if (layers.isEmpty()) 0.0 else widest + 2 * metrics.margin
        var width = if (across) planAlong else planBreadth
        var height = if (across) planBreadth else planAlong

        if (loose.isNotEmpty()) {
            val rowLimit = max(width, availableWidth) - 2 * metrics.margin
            var x = metrics.margin
            var y = if (height > 0) height - metrics.margin + metrics.rankGap / 2 else metrics.margin
            var rowHeight = 0.0
            var rightmost = 0.0
            loose.forEach { mark ->
                val (w, h) = size(mark)
                if (x > metrics.margin && x + w > metrics.margin + rowLimit) { x = metrics.margin; y += rowHeight + metrics.markGap; rowHeight = 0.0 }
                boxes[mark.id] = Box(x, y, w, h)
                rightmost = max(rightmost, x + w); x += w + metrics.markGap; rowHeight = max(rowHeight, h)
            }
            width = max(width, rightmost + metrics.margin)
            height = y + rowHeight + metrics.margin
        }

        val routes = chains.mapNotNull { (edge, path) ->
            val first = boxes[path.first()] ?: return@mapNotNull null
            val last = boxes[path.last()] ?: return@mapNotNull null
            val points = mutableListOf(if (across) Point(first.maxX, first.midY) else Point(first.midX, first.maxY))
            var level = if (across) first.midY else first.midX
            path.drop(1).forEach { id ->
                val box = boxes[id] ?: return@forEach
                val r = nodes[id]?.rank ?: return@forEach
                val turn = starts[r] - metrics.rankGap / 2
                val next = if (across) box.midY else box.midX
                if (abs(next - level) > 0.5) {
                    points += if (across) Point(turn, level) else Point(level, turn)
                    points += if (across) Point(turn, next) else Point(next, turn)
                }
                level = next
            }
            points += if (across) Point(last.x, last.midY) else Point(last.midX, last.y)
            Route(edge.source, edge.target, points)
        }
        return Layout(direction, width, height, unique.mapNotNull { mark -> boxes[mark.id]?.let { Placement(mark, it) } }, routes)
    }
}
