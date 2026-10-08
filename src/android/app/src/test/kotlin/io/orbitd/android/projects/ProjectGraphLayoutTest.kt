package io.orbitd.android.projects

import org.junit.Assert.*
import org.junit.Test
import java.io.File

/** ProjectGraphLayoutTests.swift, case for case, plus what a phone must survive: a 500-mark plan,
 * a cycle and edges that name nothing. */
class ProjectGraphLayoutTest {
    private fun task(id: String, title: String = id, status: String = "OPEN", workState: String? = null, parent: String? = null,
        running: Boolean = false, verification: String? = null) =
        GraphMark(MarkKind.TASK, id, title, parent, id, status, running, false, workState, verification)
    private val baseline = task("t00", "Baseline", "DONE", "DONE")
    private fun done(id: String) = task(id, "Done $id", "DONE", "DONE")
    private fun ready(id: String) = task(id, "Ready $id", "OPEN", "READY")
    private fun edge(a: String, b: String) = GraphEdge(a, b)
    private val realShape: DependencyGraph get() {
        val doneIds = listOf("t01", "t02", "t03", "t04")
        val readyIds = listOf("t05", "t06", "t07", "t08", "t09", "t10")
        val marks = listOf(baseline) + doneIds.map(::done) + readyIds.map(::ready) + task("t11", "Bound seen", "CANCELLED", "CANCELLED") + ready("t12")
        val edges = (doneIds + readyIds + "t11").map { edge("t00", it) } + edge("t01", "t06")
        return DependencyGraph(marks, edges, 13, false, null)
    }

    @Test fun aConnectedBlockOfFinishedWorkFoldsIntoOneMark() {
        val (marks, edges) = ProjectGraphLayout.prepare(realShape, emptySet())
        val fold = marks.first { it.kind == MarkKind.SETTLED }
        assertEquals("5 done", fold.title); assertEquals(5, fold.taskCount); assertEquals("settled:t00", fold.id)
        assertEquals(9, marks.size)
        val fromFold = edges.filter { it.source == "settled:t00" }.map { it.target }
        assertEquals(setOf("t05", "t06", "t07", "t08", "t09", "t10", "t11"), fromFold.toSet()); assertEquals(7, fromFold.size)
    }

    @Test fun aFoldTheReaderOpenedIsDrawnInFull() {
        val (marks, _) = ProjectGraphLayout.prepare(realShape, setOf("settled:t00"))
        assertTrue(marks.none { it.kind == MarkKind.SETTLED }); assertEquals(13, marks.size)
    }

    @Test fun oneFinishedTaskOrTwoUnderDifferentParentsAreNotFolded() {
        assertEquals(listOf("a", "b"), ProjectGraphLayout.foldSettled(listOf(done("a"), ready("b")), listOf(edge("a", "b")), emptySet()).first.map { it.id })
        val split = ProjectGraphLayout.foldSettled(listOf(task("a", status = "DONE", parent = "p1"), task("b", status = "DONE", parent = "p2")), listOf(edge("a", "b")), emptySet())
        assertEquals(listOf("a", "b"), split.first.map { it.id })
    }

    @Test fun anOpenedRunIsItsStepsInOrderWithItsEdgesMovedOntoThem() {
        val run = GraphMark(MarkKind.RUN, "run:1", "3 steps", taskCount = 3, statusCounts = mapOf("OPEN" to 3),
            members = listOf(GraphMember("s1", "one", "OPEN"), GraphMember("s2", "two", "OPEN"), GraphMember("s3", "three", "OPEN")), expandable = true)
        val graph = DependencyGraph(listOf(ready("a"), run, ready("z")), listOf(edge("a", "run:1"), edge("run:1", "z")), 5, false, null)
        assertEquals(listOf("a", "run:1", "z"), ProjectGraphLayout.prepare(graph, emptySet()).first.map { it.id })
        val (marks, edges) = ProjectGraphLayout.prepare(graph, setOf("run:1"))
        assertEquals(listOf("a", "s1", "s2", "s3", "z"), marks.map { it.id })
        assertEquals(setOf(edge("a", "s1"), edge("s3", "z"), edge("s1", "s2"), edge("s2", "s3")), edges.toSet())
        assertTrue(ProjectGraphLayout.canOpen(run))
    }

    @Test fun theSummarySaysHowBigHowFarAndWhatCanStart() {
        assertEquals("13 tasks · 7 ready to run · 5 done · dashed marks are folded", ProjectGraphLayout.summary(13, ProjectGraphLayout.prepare(realShape, emptySet()).first))
        assertEquals("13 tasks · 7 ready to run · 5 done", ProjectGraphLayout.summary(13, ProjectGraphLayout.prepare(realShape, setOf("settled:t00")).first))
    }

    @Test fun eachMarkSaysTheOneThingWorthReadingAboutIt() {
        assertEquals("Ready to run", ProjectGraphLayout.meta(ready("a"), 0))
        val blocked = task("b", workState = "BLOCKED")
        assertEquals("Waiting on 2", ProjectGraphLayout.meta(blocked, 2)); assertEquals("Blocked", ProjectGraphLayout.meta(blocked, 0))
        val cancelled = task("c", status = "CANCELLED")
        assertEquals("Cancelled", ProjectGraphLayout.meta(cancelled, 0)); assertEquals(ProjectGraphLayout.Tone.FAILED, ProjectGraphLayout.tone(cancelled))
        assertEquals("Running", ProjectGraphLayout.meta(task("r", workState = "RUNNING", running = true), 0))
        assertEquals("Awaiting verification · verifier running", ProjectGraphLayout.meta(task("v", workState = "AWAITING_VERIFICATION", verification = "RUNNING"), 0))
    }

    @Test fun aFoldSaysWhatItHoldsAndSettledWorkSaysOnlyThatItIsFinished() {
        val fold = ProjectGraphLayout.prepare(realShape, emptySet()).first.first { it.kind == MarkKind.SETTLED }
        assertEquals("5 done", ProjectGraphLayout.foldTitle(fold)); assertEquals("Finished · tap to open", ProjectGraphLayout.foldLegend(fold))
        assertEquals(ProjectGraphLayout.State.COMPLETE, ProjectGraphLayout.state(fold))
        val motif = GraphMark(MarkKind.MOTIF, "m", "Review", taskCount = 6, statusCounts = mapOf("DONE" to 4, "FAILED" to 1, "OPEN" to 1))
        assertEquals("4 done · 1 failed · 1 open", ProjectGraphLayout.foldLegend(motif))
        assertEquals(ProjectGraphLayout.State.FAILED, ProjectGraphLayout.state(motif)); assertFalse(ProjectGraphLayout.canOpen(motif))
    }

    @Test fun waitingCountsOnlyPrerequisitesThatHaveNotReleasedTheTask() {
        assertEquals(1, ProjectGraphLayout.waitingOn(listOf(done("a"), ready("b"), task("c", workState = "BLOCKED")), listOf(edge("a", "c"), edge("b", "c")))["c"])
    }

    private fun assertNoOverlap(layout: ProjectGraphLayout.Layout) {
        val boxes = layout.placements.map { it.box }
        boxes.forEachIndexed { i, a -> boxes.drop(i + 1).forEach { b ->
            assertTrue("$a overlaps $b", a.maxX <= b.x || b.maxX <= a.x || a.maxY <= b.y || b.maxY <= a.y)
        } }
    }

    @Test fun aWideShallowPlanReadsLeftToRightInOneScreenWidth() {
        val (marks, edges) = ProjectGraphLayout.prepare(realShape, emptySet())
        val layout = ProjectGraphLayout.layout(marks, edges, 361.0)
        assertEquals(ProjectGraphLayout.Direction.LEFT_TO_RIGHT, layout.direction)
        assertTrue(layout.width <= 361); assertEquals(1.0, layout.fit(361.0), 0.0)
        assertNoOverlap(layout)
        val fold = layout.placements.first { it.mark.kind == MarkKind.SETTLED }.box
        val dependents = layout.placements.filter { it.mark.id in setOf("t05", "t06", "t07", "t08", "t09", "t10", "t11") }
        assertEquals(7, dependents.size); assertTrue(dependents.all { it.box.x > fold.maxX })
        val loose = layout.placements.first { it.mark.id == "t12" }.box
        assertTrue(dependents.all { it.box.maxY < loose.y })
        assertEquals(7, layout.routes.size)
        layout.routes.forEach { route ->
            val target = layout.placements.first { it.mark.id == route.target }.box
            assertEquals(fold.maxX, route.points.first().x, 0.0); assertEquals(target.x, route.points.last().x, 0.0); assertEquals(target.midY, route.points.last().y, 0.0)
        }
    }

    @Test fun aDeepChainReadsTopToBottom() {
        val ids = (0 until 6).map { "c$it" }
        val layout = ProjectGraphLayout.layout(ids.map(::ready), ids.zipWithNext().map { (a, b) -> edge(a, b) }, 361.0)
        assertEquals(ProjectGraphLayout.Direction.TOP_TO_BOTTOM, layout.direction); assertTrue(layout.width <= 361)
        val ys = layout.placements.map { it.box.y }
        assertEquals(ys.sorted(), ys); assertNoOverlap(layout)
    }

    @Test fun anEdgeThatSkipsARankPassesThroughASlotOfItsOwn() {
        val layout = ProjectGraphLayout.layout(listOf(ready("a"), ready("b"), ready("c")), listOf(edge("a", "b"), edge("b", "c"), edge("a", "c")),
            ProjectGraphLayout.Direction.LEFT_TO_RIGHT, 800.0)
        val middle = layout.placements.first { it.mark.id == "b" }.box
        val long = layout.routes.first { it.source == "a" && it.target == "c" }
        long.points.zipWithNext().forEach { (p, q) ->
            val crosses = minOf(p.x, q.x) < middle.maxX && maxOf(p.x, q.x) > middle.x && minOf(p.y, q.y) < middle.maxY && maxOf(p.y, q.y) > middle.y
            assertFalse("segment $p→$q runs through $middle", crosses)
        }
        assertNoOverlap(layout)
    }

    @Test fun marksWithNoEdgesAtAllAreSetOutInRows() {
        val layout = ProjectGraphLayout.layout((0 until 5).map { ready("m$it") }, emptyList(), 361.0)
        assertEquals(5, layout.placements.size); assertTrue(layout.width <= 361); assertTrue(layout.routes.isEmpty()); assertNoOverlap(layout)
    }

    @Test fun theTruncationNoticeNamesTheLimit() {
        assertEquals("This project is larger than one graph request reads (500 tasks).", ProjectGraphLayout.truncatedNotice(500).first)
        assertEquals("1,234", ProjectGraphLayout.number(1234))
    }

    @Test fun aServerSizedPlanACycleAndDanglingEdgesNeverThrow() {
        // The server's cap: 500 marks, a wide fan-out plus a long chain plus loose marks.
        val marks = (0 until 500).map { i -> if (i % 7 == 0) done("n$i") else ready("n$i") }
        val edges = (1 until 300).map { edge("n0", "n$it") } + (300 until 420).map { edge("n${it - 1}", "n$it") } + edge("n5", "missing")
        val layout = ProjectGraphLayout.layout(ProjectGraphLayout.prepare(DependencyGraph(marks, edges, 500, true, 500), emptySet()).first, edges, 361.0)
        assertTrue(layout.placements.isNotEmpty())
        assertTrue(layout.width.isFinite() && layout.height.isFinite())
        // A cycle is never sent by the server; it still lays out, and folding refuses to close one.
        val cycle = ProjectGraphLayout.layout(listOf(ready("a"), ready("b")), listOf(edge("a", "b"), edge("b", "a")), 361.0)
        assertEquals(2, cycle.placements.size)
        assertTrue(ProjectGraphLayout.hasCycle(listOf(ready("a"), ready("b")), listOf(edge("a", "b"), edge("b", "a"))))
        val duplicate = ProjectGraphLayout.layout(listOf(ready("a"), ready("a")), emptyList(), 361.0)
        assertEquals(1, duplicate.placements.size)
    }

    @Test fun theGraphWordsAreTheSwiftSources() {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }.first { File(it, "src/macos/OrbitKit/Sources/OrbitKit").isDirectory }
        val swift = File(root, "src/macos/OrbitKit/Sources/OrbitKit/App/ProjectGraphLayout.swift").readText()
        listOf("Ready to run", "Blocked", "Running", "Queued", "Verification failed", "Missing verifier", "Awaiting verification · verifier running",
            "Awaiting verification · verifier blocked", "Awaiting verification · applying result", "Awaiting verification", "Finished · tap to open",
            "dashed marks are folded", "The task list below has all of them, in dependency order.").forEach {
            assertTrue("\"$it\" is not in ProjectGraphLayout.swift", swift.contains("\"$it\""))
        }
        val view = File(root, "src/macos/OrbitApp/Sources/OrbitApp/Views/ProjectGraphView.swift").readText()
        listOf("Task graph", "Show the task graph full screen").forEach { assertTrue(view.contains("\"$it\"")) }
    }
}
