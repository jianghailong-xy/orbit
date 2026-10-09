package io.orbitd.android.core.cards

import io.orbitd.android.core.protocol.Wire
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/**
 * A08-7 (iOS 96c9a964d): the batch-create review — case for case with OrbitKit's BatchReviewTests: the consequence split at its dash,
 * a detail line that does not open on a separator, the tasks by level with every prerequisite named by its number, and a page per
 * task read off the bodies the runner sends.
 */
class BatchReviewTest {
    private fun json(s: String) = Wire.json.parseToJsonElement(s).jsonObject
    private fun task(title: String, ref: String? = null, on: List<String> = emptyList(), outside: List<String> = emptyList()) =
        BatchTask(title, ref, on, outside)

    /** 1 → 2, 3 → 4, and 1 also waits on a task that already exists. */
    private val diamond = listOf(task("oauth", "a", outside = listOf("existing-1")), task("button", "b", listOf("a")),
        task("signup", "c", listOf("a")), task("e2e", "d", listOf("b", "c")))

    @Test fun independentTasksAreOneNumberedLevel() {
        val levels = BatchReview.levels(listOf(task("管理员共享模型提供方的 API key"), task("池网关原样转发"), task("T1 用户路由普查")))
        assertEquals("no edges, so one level — the review draws it as a plain list", 1, levels.size)
        assertEquals(listOf(1, 2, 3), levels[0].rows.map { it.number })
        assertTrue(levels[0].rows.all { it.waitsOn.isEmpty() && !it.waitsOutside })
    }

    @Test fun aDiamondIsListedByLevelAndNamesEveryPrerequisite() {
        val levels = BatchReview.levels(diamond)
        assertEquals(listOf(listOf("oauth"), listOf("button", "signup"), listOf("e2e")), levels.map { level -> level.rows.map { it.title } })
        assertEquals(listOf(1, 2, 3, 4), levels.flatMap { it.rows }.map { it.number })
        assertEquals(listOf(2, 3), levels[2].rows[0].waitsOn)
        assertEquals(listOf(listOf(1), listOf(1)), levels[1].rows.map { it.waitsOn })
        assertTrue(levels[0].rows[0].waitsOutside)
        assertFalse(levels[2].rows[0].waitsOutside)
        assertEquals(listOf("Level 1", "Level 2", "Level 3"), levels.map(BatchReview::levelName))
        assertEquals(listOf(null, "2 in parallel", null), levels.map(BatchReview::levelParallel))
        assertEquals("3 levels, up to 2 in parallel", BatchReview.shape(diamond))
    }

    @Test fun numbersFollowTheLevelsSoAPrerequisiteAlwaysComesFirst() {
        val levels = BatchReview.levels(listOf(task("a", "a"), task("b", "b", listOf("a")), task("c")))
        assertEquals(listOf(listOf("a", "c"), listOf("b")), levels.map { level -> level.rows.map { it.title } })
        assertEquals(listOf(1, 2, 3), levels.flatMap { it.rows }.map { it.number })
        assertEquals(listOf(1), levels[1].rows[0].waitsOn)
        assertEquals("the batch position, which the task page reads the body by", listOf(0, 2, 1), levels.flatMap { it.rows }.map { it.index })
    }

    @Test fun aJoinSitsUnderItsDeepestPrerequisite() {
        val tasks = listOf(task("a", "a"), task("b", "b", listOf("a")), task("j", "j", listOf("a", "b")))
        val levels = BatchReview.levels(tasks)
        assertEquals(3, levels.size)
        assertEquals(listOf(1, 2), levels[2].rows[0].waitsOn)
        assertEquals("a chain of 3", BatchReview.shape(tasks))
    }

    @Test fun aRefNamingNothingInTheWindowLeavesTheTaskOnTheFirstLevel() {
        val levels = BatchReview.levels(listOf(task("a", "a", listOf("not-shown", "a"))))
        assertEquals(1, levels.size)
        assertEquals("nor does a task wait on itself", emptyList<Int>(), levels[0].rows[0].waitsOn)
    }

    @Test fun neededByIsWhatWaitsOnARow() {
        val levels = BatchReview.levels(diamond)
        val rows = levels.flatMap { it.rows }
        assertEquals(listOf(2, 3), BatchReview.neededBy(rows[0], levels).map { it.number })
        assertEquals(listOf(4), BatchReview.neededBy(rows[1], levels).map { it.number })
        assertEquals(emptyList<BatchLevelRow>(), BatchReview.neededBy(rows[3], levels))
    }

    @Test fun anEmptyWindowHasNoLevels() = assertEquals(emptyList<BatchLevel>(), BatchReview.levels(emptyList()))

    @Test fun afterOneIsSaidOnlyWhenOneTaskReleasesTheRest() {
        val fanOut = listOf(task("r", "r"), task("x", "x", listOf("r")), task("y", "y", listOf("r")), task("z", "z", listOf("r")))
        assertEquals("3 in parallel after 1", BatchReview.shape(fanOut))
        val fanIn = listOf(task("a", "a"), task("b", "b"), task("c", "c"), task("d", "d", listOf("a", "b")))
        assertEquals("2 levels, up to 3 in parallel", BatchReview.shape(fanIn))
    }

    @Test fun theDetailLineDoesNotOpenOnASeparator() {
        assertEquals("3 independent tasks", BatchReview.detailLine(json("""{"taskCount":3,"needsManualStart":3,"tasks":[{"title":"a"},{"title":"b"},{"title":"c"}]}""")))
        assertEquals("into Backlog · 2 independent tasks", BatchReview.detailLine(json("""{"taskCount":2,"lists":[{"title":"Backlog"}],"tasks":[{"title":"a"},{"title":"b"}]}""")))
        assertEquals("1 dependency edge · a chain of 2", BatchReview.detailLine(json(
            """{"taskCount":2,"internalEdges":1,"externalEdges":0,"tasks":[{"title":"a","ref":"a"},{"title":"b","ref":"b","dependsOnRefs":["a"]}]}""")))
        assertEquals("", BatchReview.detailLine(json("""{"taskCount":0}""")))
    }

    @Test fun impactRowsKeepTheSentenceAndSplitItAtTheDash() {
        val preview = json("""{"taskCount":6,"startingNow":1,"blocked":2,"needsManualStart":2,"notDispatchable":1}""")
        val rows = BatchReview.impactRows(preview)
        assertEquals(listOf(BatchImpactRow.Kind.STARTING, BatchImpactRow.Kind.WAITING, BatchImpactRow.Kind.MANUAL_START, BatchImpactRow.Kind.CANNOT_RUN),
            rows.map { it.kind })
        assertEquals("one set of sentences, not two", batchImpactLines(preview), rows.map { it.text })
        assertEquals("1 starts running within the minute", rows[0].head)
        assertNull(rows[0].reason)
        assertEquals("2 need a manual start", rows[2].head)
        assertEquals("Nothing will trigger them", rows[2].reason)
        assertEquals("1 cannot run", rows[3].head)
        assertEquals("Unassigned, no runner, auto-run off, or the list is paused", rows[3].reason)
    }

    @Test fun aSingleCreateCarriesTheSameRows() {
        val rows = BatchReview.impactRows(json("""{"taskCount":1,"needsManualStart":1}"""))
        assertEquals(listOf(BatchImpactRow.Kind.MANUAL_START), rows.map { it.kind })
        assertEquals("Nothing will trigger it", rows[0].reason)
    }

    @Test fun aTaskPageReadsTheBodyTheRunnerSends() {
        val input = json("""{"tasks":[
            {"title":"oauth","description":"## 背景\nwhy","acceptanceCriteria":"done when","completionCriterion":"EVIDENCE_JUDGMENT","labels":["google-sign-in"]},
            {"title":"button"}],
            "preview":{"taskCount":2,"tasks":[{"title":"oauth"},{"title":"button"}]}}""")
        val details = BatchReview.details(input)
        val rows = BatchReview.levels(BatchReview.tasks(input.obj("preview"))).flatMap { it.rows }
        val first = BatchReview.detail(rows[0], details)
        assertEquals("## 背景\nwhy", first?.description)
        assertEquals("done when", first?.acceptanceCriteria)
        assertEquals(listOf("google-sign-in"), first?.labels)
        assertEquals("Judged by · submitted evidence", first?.judgedBy)
        val second = BatchReview.detail(rows[1], details)
        assertEquals("", second?.description)
        assertNull("no criterion declared, no chip", second?.judgedBy)
    }

    @Test fun aTaskPageNeverShowsAnotherTasksBody() {
        val details = listOf(BatchTaskDetail("b", "b's"), BatchTaskDetail("a", "a's"))
        assertEquals("the position disagrees with the title, so the title decides", "a's",
            BatchReview.detail(BatchLevelRow(0, 1, "a", emptyList(), false), details)?.description)
        assertNull(BatchReview.detail(BatchLevelRow(0, 1, "z", emptyList(), false), details))
        assertEquals(emptyList<BatchTaskDetail>(), BatchReview.details(json("{}")))
    }

    @Test fun theCardSaysHowManyItCreates() {
        assertEquals("Create 3 tasks", BatchReview.createAction(3))
        assertEquals("Create 1 task", BatchReview.createAction(1))
        assertEquals("Task 1 of 3", BatchReview.taskPageTitle(1, 3))
        assertEquals("a window that does not hold the whole batch has no total to name", "Task 4", BatchReview.taskPageTitle(4, null))
        assertEquals("+38 more", BatchReview.more(38))
    }

    /** The shared corpus's batch: two tasks, the answer waiting on the read. */
    @Test fun theCorpusBatchIsTwoLevelsAndOneWait() {
        val preview = cardList().single { it.key == "approval:a5" }.source.obj("input")!!.obj("preview")!!
        val levels = BatchReview.levels(BatchReview.tasks(preview))
        assertEquals(listOf(listOf("Read the question"), listOf("Answer it")), levels.map { level -> level.rows.map { it.title } })
        assertEquals(listOf(1), levels[1].rows[0].waitsOn)
        assertEquals("into Cards · 1 dependency edge · a chain of 2", BatchReview.detailLine(preview))
        assertEquals(listOf("1 waits on a prerequisite", "1 needs a manual start"), BatchReview.impactRows(preview).map { it.head })
    }
}
