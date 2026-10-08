package io.orbitd.android.projects

import io.orbitd.android.core.cards.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** "Start this project?" — OrbitKit's `StartProjectTests` (main 50e7ca040/ba2023445) held over the same inputs: the plan in
 * levels, what still comes to the owner under the Automatic switch, the line under Start, the body a press sends, and
 * when the card is asked at all. The words themselves are ProjectCopyParityTest's and StartProjectCardCopyTest's. */
class StartProjectTest {
    private val project = "34WvwUS8YMXfOfWbMqVuu"
    private val seal = "c2b4e16c4b59" + "0".repeat(52)
    private val moved = "9c4f7a1bb001" + "2".repeat(52)
    private fun j(text: String) = Json.parseToJsonElement(text).jsonObject

    private fun request(line: String = "PROJECT_BRANCH") = StartProjectCopy.Request(
        StartProjectCopy.Settings(line, "refs/heads/project/$project", true, 3, "cd src/web && npx tsc -b && npx vitest run"),
        "B and C both build on A — one branch checks them together before main.", seal)

    /** The plan of the mock: A, then B and C, then D after B, then E after C and D — four tasks settled on their evidence and
     * the last one, the go-live, confirmed by the owner. */
    private fun graph(folded: Boolean = false): DependencyGraph {
        val marks = listOf(
            Triple("task-a", "A · 提醒规则做成两端共用的真源", "EVIDENCE_JUDGMENT"),
            Triple("task-b", "B · OrbitKit：提醒规则、文案、DTO 与接口", "EVIDENCE_JUDGMENT"),
            Triple("task-c", "C · web：Runners 列表与 runner 详情页", "EVIDENCE_JUDGMENT"),
            Triple("task-d", "D · iOS/macOS：Runners 列表、Add Runner、Edit", "EVIDENCE_JUDGMENT"),
            Triple("task-e", "E · 上线", "OWNER_CONFIRMED"),
        ).map { (id, title, criterion) -> GraphMark(MarkKind.TASK, id, title, taskId = id, status = "OPEN", completionCriterion = criterion, autoRunWhenReady = true) } +
            if (folded) listOf(GraphMark(MarkKind.MOTIF, "motif-1", "12 more", taskCount = 12)) else emptyList()
        val edges = listOf("task-a" to "task-b", "task-a" to "task-c", "task-b" to "task-d", "task-c" to "task-e", "task-d" to "task-e").map { GraphEdge(it.first, it.second) }
        return DependencyGraph(marks, edges, if (folded) 900 else 5, false, null)
    }

    // MARK: the plan, by level

    @Test fun aTaskIsNamedByTheMarkerItsTitleOpensWith() {
        assertEquals("A", StartProjectCopy.planTaskLabel("A · 提醒规则做成两端共用的真源"))
        assertEquals("①", StartProjectCopy.planTaskLabel("① 服务端 · 开工门"))
        assertEquals("B", StartProjectCopy.planTaskLabel("B：OrbitKit 接口"))
        assertEquals("12", StartProjectCopy.planTaskLabel("12) wire the card"))
        assertEquals("Fix login redirect", StartProjectCopy.planTaskLabel("Fix login redirect"))
        // "A new card" opens with a word, not a marker.
        assertEquals("A new card for the start", StartProjectCopy.planTaskLabel("A new card for the start"))
        assertEquals("x".repeat(23) + "…", StartProjectCopy.planTaskLabel("x".repeat(40)))
        // Three digits are not a marker, and a dash with no space after it is part of a word.
        assertEquals("123) three", StartProjectCopy.planTaskLabel("123) three"))
        assertEquals("E -mail", StartProjectCopy.planTaskLabel("E -mail"))
        assertEquals("E", StartProjectCopy.planTaskLabel("E - mail"))
        // A capital, one or two digits and at most one small letter is a code, and a space after it is enough.
        assertEquals("P1", StartProjectCopy.planTaskLabel("P1 Web：合并 Runners 与 Providers 为 Infrastructure 页"))
        assertEquals("P5", StartProjectCopy.planTaskLabel("P5：接通 Web、macOS 和 iOS 的 DeepSeek Harness 操作链"))
        assertEquals("D12", StartProjectCopy.planTaskLabel("D12. wire the card"))
        assertEquals("P1a", StartProjectCopy.planTaskLabel("P1a · wiki-worker 服务骨架与 System model 客户端"))
        assertEquals("P12c", StartProjectCopy.planTaskLabel("P12c: the third part"))
        assertEquals("v2 API changes", StartProjectCopy.planTaskLabel("v2 API changes"))
        assertEquals("P123 three", StartProjectCopy.planTaskLabel("P123 three"))
        assertEquals("P1ab two letters", StartProjectCopy.planTaskLabel("P1ab two letters"))
        // The rest of a title, once the plan names it by its label.
        assertEquals("wiki-worker 服务骨架", StartProjectCopy.planTaskRest("P1a · wiki-worker 服务骨架", "P1a"))
        assertEquals("OrbitKit 接口", StartProjectCopy.planTaskRest("B：OrbitKit 接口", "B"))
        assertEquals("Fix login redirect", StartProjectCopy.planTaskRest("Fix login redirect", "Fix login redirect"))
    }

    @Test fun eachTaskSitsOneLevelAfterTheDeepestOfWhatItWaitsOn() {
        val g = graph()
        val tasks = g.marks.map { mark -> StartProjectCopy.PlanTask(mark.id, mark.title, g.edges.filter { it.target == mark.id }.map { it.source },
            mark.completionCriterion, mark.autoRunWhenReady) }
        val levels = StartProjectCopy.planLevels(tasks)
        assertEquals(listOf(listOf("A"), listOf("B", "C"), listOf("D"), listOf("E")), levels.map { level -> level.map { it.label } })
        assertTrue("the first level starts with the project", levels.first().first().now)
        assertTrue("the go-live is the owner's to confirm", levels.last().first().you)
        // A task set to start by hand does not start with the project.
        assertFalse(StartProjectCopy.planLevels(listOf(StartProjectCopy.PlanTask("x", "X · one", autoRunWhenReady = false))).first().first().now)
        // A prerequisite outside the plan — settled work, another project — waits on nothing here.
        assertEquals(1, StartProjectCopy.planLevels(listOf(StartProjectCopy.PlanTask("x", "X · one", listOf("elsewhere")))).size)
        // A cycle the server would never have allowed is cut rather than followed.
        assertTrue(StartProjectCopy.planLevels(listOf(StartProjectCopy.PlanTask("x", "X · one", listOf("y")),
            StartProjectCopy.PlanTask("y", "Y · two", listOf("x")))).isNotEmpty())
        assertEquals("Plan · 5 tasks in 4 levels", StartProjectCopy.planHead(5, levels = 4))
        assertEquals("Plan · 5 tasks", StartProjectCopy.planHead(5))
        assertEquals("Plan · 1 task", StartProjectCopy.planHead(1))
        assertEquals("5 in parallel", StartProjectCopy.inParallel(5))
    }

    @Test fun thePlanIsReadOffTheGraphWithWhoConfirmsWhatAndWhatStartsNow() {
        val view = StartProjectCopy.planView(graph(), 0)
        assertEquals(5, view.count)
        assertEquals(listOf(listOf("A"), listOf("B", "C"), listOf("D"), listOf("E")), view.levels?.map { level -> level.map { it.label } })
        assertEquals(listOf(StartProjectCopy.NamedTask("E", "上线")), view.ownerConfirmed)
        assertEquals(4, view.evidenceJudged)
        assertEquals(listOf("A"), view.startsNow)
    }

    /** A folded plan is too big to list: it says how many and nothing about their order. */
    @Test fun aFoldedPlanSaysHowManyAndNothingAboutTheirOrder() {
        val folded = StartProjectCopy.planView(graph(folded = true), 0)
        assertEquals(900, folded.count)
        assertNull(folded.levels)
        assertEquals(emptyList<String>(), folded.startsNow)
        // …and a graph that has not been read says the project's own count.
        val unread = StartProjectCopy.planView(null, 5)
        assertEquals(5, unread.count)
        assertNull(unread.levels)
        // Cancelled work is not part of the plan; settled work runs nothing, so has no place in it.
        val settled = DependencyGraph(listOf(GraphMark(MarkKind.TASK, "a", "A · one", status = "DONE"), GraphMark(MarkKind.TASK, "b", "B · two", status = "OPEN"),
            GraphMark(MarkKind.TASK, "c", "C · three", status = "CANCELLED")), listOf(GraphEdge("a", "b")), 3, false, null)
        val view = StartProjectCopy.planView(settled, 0)
        assertEquals(2, view.count)
        assertEquals(listOf(listOf("B")), view.levels?.map { level -> level.map { it.label } })
        assertEquals(listOf("B"), view.startsNow)
    }

    @Test fun theGraphMarksCarryHowEachTaskIsSettledAndWhetherItStartsByItself() {
        val mark = GraphMark.of(j("""{"kind":"TASK","id":"t","title":"E · 上线","status":"OPEN","completionCriterion":"OWNER_CONFIRMED","autoRunWhenReady":false}"""))!!
        assertEquals("OWNER_CONFIRMED", mark.completionCriterion)
        assertEquals(false, mark.autoRunWhenReady)
        // An older server says neither, and the first level then starts with the project.
        val older = GraphMark.of(j("""{"kind":"TASK","id":"t","title":"E · 上线","status":"OPEN"}"""))!!
        assertNull(older.completionCriterion); assertNull(older.autoRunWhenReady)
        assertEquals(listOf("E"), StartProjectCopy.planView(DependencyGraph(listOf(older), emptyList(), 1, false, null), 0).startsNow)
    }

    // MARK: what still comes to the owner

    @Test fun withAutomaticOnTheOwnerKeepsTheTasksTheyConfirmTheCriteriaAndWhatCannotBeResolved() {
        val p10 = listOf(StartProjectCopy.NamedTask("P10", "本部署切换到服务端执行"))
        assertEquals(listOf(
            StartProjectCopy.ComesToYouItem("P10 · 本部署切换到服务端执行", "you confirm it"),
            StartProjectCopy.ComesToYouItem("Any change to the criteria"),
            StartProjectCopy.ComesToYouItem("Problems it can’t resolve within 2 h"),
        ), StartProjectCopy.comesToYou(true, "PROJECT_BRANCH", p10, 11, 7_200))
        // Directly into main, every merge asks the owner whoever runs the project.
        assertEquals(listOf("Each merge into main", "Any change to the criteria", "Problems it can’t resolve within 30 min"),
            StartProjectCopy.comesToYou(true, "MAIN", emptyList(), 0, 1_800).map { it.text })
    }

    @Test fun withAutomaticOffEveryDecisionTheCoordinatorWouldHaveMadeComesToTheOwner() {
        val p10 = listOf(StartProjectCopy.NamedTask("P10", "本部署切换到服务端执行"))
        assertEquals(listOf(
            StartProjectCopy.ComesToYouItem("Whether each task is done", "11 reviews"),
            StartProjectCopy.ComesToYouItem("P10 · 本部署切换到服务端执行", "you confirm it"),
            StartProjectCopy.ComesToYouItem("Problems along the way", "conflicts, failed checks"),
            StartProjectCopy.ComesToYouItem("Merging the branch into main"),
            StartProjectCopy.ComesToYouItem("Any change to the criteria"),
        ), StartProjectCopy.comesToYou(false, "PROJECT_BRANCH", p10, 11, 7_200))
        assertEquals(StartProjectCopy.ComesToYouItem("Whether each task is done"), StartProjectCopy.comesToYou(false, "MAIN", emptyList(), 0, 7_200).first())
        val many = listOf("A", "B", "C", "D").map { StartProjectCopy.NamedTask(it, "$it task") }
        assertEquals(StartProjectCopy.ComesToYouItem("4 tasks you confirm"), StartProjectCopy.comesToYou(true, "PROJECT_BRANCH", many, 0, 7_200).first())
        assertEquals("2 h", StartProjectCopy.within(7_200))
        assertEquals("2 h", StartProjectCopy.within(5_400))
        assertEquals("10 min", StartProjectCopy.within(600))
        assertEquals("1 review", StartProjectCopy.reviews(1))
    }

    // MARK: the words that are built

    @Test fun theHeaderTheNoteAndTheLineUnderStartMatchTheBrowsersExamples() {
        assertEquals("The coordinator asked 56m ago", StartProjectCopy.askedLine("56m ago"))
        assertEquals("Nobody asked yet", StartProjectCopy.nobodyAskedLine(hasCoordinator = true))
        assertEquals("Nobody asked yet · no coordinator yet", StartProjectCopy.nobodyAskedLine(hasCoordinator = false))
        assertEquals("Automatic is on by default (the coordinator suggested off). The rest is the coordinator’s suggestion. " +
            "You can change any of these later on the project page.", StartProjectCopy.howItRunsNote(asked = true, suggestedOff = true))
        assertEquals("Automatic is on by default. You can change any of these later on the project page.",
            StartProjectCopy.howItRunsNote(asked = false, suggestedOff = false))
        assertEquals("Starts P1a now · confirms these 7 criteria · seal 7c1e9a42", StartProjectCopy.barCaption(false, listOf("P1a"), 7, "7c1e9a42"))
        assertEquals("Opens a coordinator · starts P1a now · confirms these 7 criteria", StartProjectCopy.barCaption(true, listOf("P1a"), 7, "7c1e9a42"))
        assertEquals("Confirms this criterion · seal abc", StartProjectCopy.barCaption(false, emptyList(), 1, "abc"))
        assertEquals("Starts A, B and C now · confirms these 2 criteria · seal abc", StartProjectCopy.barCaption(false, listOf("A", "B", "C"), 2, "abc"))
        assertEquals("Done when · 4 criteria", StartProjectCopy.doneWhenHead(4))
        assertEquals("Done when · 1 criterion", StartProjectCopy.doneWhenHead(1))
    }

    @Test fun theAutomaticSentenceFollowsTheLineAndTheMergeCheck() {
        // The start card's own sentence, for the switch, the line and the merge check.
        assertEquals(RunSettings.automaticOnChecked, RunSettings.automaticSays(true, "PROJECT_BRANCH", true))
        assertEquals(RunSettings.automaticOnUnchecked, RunSettings.automaticSays(true, "PROJECT_BRANCH", false))
        assertEquals(RunSettings.automaticOnMain, RunSettings.automaticSays(true, "MAIN", true))
        assertEquals(RunSettings.automaticOff, RunSettings.automaticSays(false, "PROJECT_BRANCH", true))
        assertEquals(RunSettings.automaticOffMain, RunSettings.automaticSays(false, "MAIN", false))
        // How it runs after the start keeps its own sentence and its amber row.
        assertEquals(RunSettings.automaticHintProjectBranch, RunSettings.automaticHint("PROJECT_BRANCH"))
        assertEquals(RunSettings.automaticHintMain, RunSettings.automaticHint("MAIN"))
        assertTrue(RunSettings.mergeCheckMissing("PROJECT_BRANCH", true, "   "))
        assertFalse(RunSettings.mergeCheckMissing("MAIN", true, null))
        assertEquals("task at a time", RunSettings.tasksAtATime(1))
        assertEquals("tasks at a time", RunSettings.tasksAtATime(3))
        // An empty merge check is a setting like any other on the start card.
        val draft = StartProjectCopy.Draft.of(request().settings)
        assertTrue(draft.hasMergeCheck)
        assertFalse(draft.copy(mergeCheckCommand = "   ").hasMergeCheck)
    }

    /** Delegating is the owner's default: the draft opens with Automatic on whatever was suggested. */
    @Test fun theDraftOpensWithAutomaticOnWhateverTheCoordinatorSuggested() {
        val suggestedOff = StartProjectCopy.Settings("PROJECT_BRANCH", null, false, 3, "npm test")
        assertEquals(StartProjectCopy.Draft("PROJECT_BRANCH", true, 3, "npm test"), StartProjectCopy.Draft.of(suggestedOff))
    }

    // MARK: what a press sends

    /** The seal it was asked about, every setting as the card shows it, and the request — the merge check and the request sent
     * either way, the branch only with a project branch. */
    @Test fun aPressSendsTheSealEverySettingAndTheRequest() {
        val draft = StartProjectCopy.Draft.of(request().settings).copy(automatic = false, maxConcurrentTasks = 5, mergeCheckCommand = "  npm test  ")
        val branch = StartProjectCopy.body(request(), draft, "item-1")
        assertEquals(j("""{"criteriaDigest":"$seal","line":"PROJECT_BRANCH","projectBranchName":"refs/heads/project/$project","automatic":false,
            "maxConcurrentTasks":5,"mergeCheckCommand":"npm test","requestId":"item-1"}"""), branch)
        val main = StartProjectCopy.body(request(), StartProjectCopy.Draft("MAIN", true, 3, "   "), null)
        assertEquals("MAIN", main.text("line"))
        assertFalse("directly into main names no branch", main.containsKey("projectBranchName"))
        assertEquals("a blank check is none, and says so", JsonNull, main["mergeCheckCommand"])
        assertEquals(JsonNull, main["requestId"])
    }

    /** The conversation's press goes through the card actions (`CardRequests`, A08); it sends what `StartProjectCopy.body` says
     * for the same request and draft. */
    @Test fun theConversationsPressSendsTheSameBody() {
        val row = j(requestRow("item-1"))
        val document = j("""{"id":"$project","title":"Aurora","startedAt":null,"acceptanceCriteriaItems":[{"id":"c1","ordinal":1,"text":"Done."}]}""")
        val reads = mapOf<String, JsonElement>("project" to document, "openItems" to j("""{"needsYou":[],"withCoordinator":[],"startRequest":${row}}"""),
            "acceptanceConfirmation" to j("""{"state":"UNCONFIRMED","confirmed":false,"currentVersion":{"digest":"$seal","material":[]}}"""))
        val card = CardCatalog.project("s1", project, reads).single { it.family == CardFamily.START }
        val request = StartProjectCopy.request(row)!!
        for (draft in listOf(StartProjectCopy.Draft.of(request.settings), StartProjectCopy.Draft("MAIN", false, 7, " make check "),
            StartProjectCopy.Draft("PROJECT_BRANCH", true, 2, ""))) {
            val sent = CardRequests.build(card, CardVerb.START, CardInput(settings = ProjectStartSettings(draft.line, draft.automatic, draft.maxConcurrentTasks,
                draft.mergeCheckCommand, request.settings.projectBranchName)))
            assertEquals(listOf("projects", project, "start"), sent.path)
            assertEquals(StartProjectCopy.body(request, draft, "item-1"), Json.parseToJsonElement(sent.body!!.decodeToString()).jsonObject)
        }
    }

    @Test fun theDraftIsCompleteOnlyInsideTheDoorsLimits() {
        val draft = StartProjectCopy.Draft.of(request().settings)
        assertTrue(draft.complete)
        assertFalse(draft.copy(maxConcurrentTasks = 0).complete)
        assertFalse(draft.copy(maxConcurrentTasks = StartProjectCopy.maxConcurrentTasks + 1).complete)
        assertTrue(draft.copy(maxConcurrentTasks = StartProjectCopy.maxConcurrentTasks).complete)
        assertEquals("project/$project", StartProjectCopy.branch(request().settings.projectBranchName, project))
    }

    // MARK: the reads

    private fun requestRow(itemId: String, line: String = "PROJECT_BRANCH", digest: String = seal) = """
        {"itemId":"$itemId","kind":"START_REQUEST","title":"Start this project?","detailLine":"",
         "assignee":"OWNER","assigneeReason":"DEFAULT","waitingSince":"2026-09-29T08:24:00.000Z",
         "escalateAt":null,"escalatedAt":null,"taskId":null,"sessionId":null,"promotionId":null,
         "fuseEpisodeId":null,"delivery":{"state":"NOT_REQUIRED","sessionId":null,"at":null},
         "actions":[],"question":null,"facts":null,
         "startRequest":{"settings":{"line":"$line","projectBranchName":"refs/heads/project/p1",
           "automatic":true,"maxConcurrentTasks":3,"mergeCheckCommand":null},
           "why":"B and C build on A","criteriaDigest":"$digest","planDigest":"pp",
           "repository":null,"warnings":[{"severity":"WARN","code":"START_TASKS_START_BY_HAND",
             "message":"m","requiredAction":"r","criterion":null,
             "tasks":[{"taskId":"t1","title":"B · two"}]}]}}
    """
    private fun openItems(row: String?) = j("""{"needsYou":[],"withCoordinator":[]${row?.let { ""","startRequest":$it""" }.orEmpty()}}""")

    @Test fun theOpenItemsReadCarriesTheRequestBesideTheOtherItems() {
        val read = openItems(requestRow("item-1"))
        val row = read.obj("startRequest")!!
        assertEquals("item-1", row.text("itemId"))
        val asked = StartProjectCopy.request(row)!!
        assertEquals("PROJECT_BRANCH", asked.settings.line)
        assertNull(asked.settings.mergeCheckCommand)
        assertEquals("B and C build on A", asked.why)
        // A server that predates start requests, and a request naming a line this build does not know: neither takes the read
        // down — the second is an item with no request on it.
        assertNull(openItems(null).obj("startRequest"))
        val unknown = openItems(requestRow("item-2", line = "SIDEWAYS"))
        assertEquals("item-2", unknown.obj("startRequest")?.text("itemId"))
        assertNull(StartProjectCopy.request(unknown.obj("startRequest")))
        assertNull("a request this build cannot read is not a card it can draw", StartProjectCopy.live(unknown, false))
    }

    @Test fun theCardIsAskedOnlyOfAProjectNobodyHasStartedAndOnlyOnARequest() {
        val read = openItems(requestRow("item-1"))
        assertEquals("item-1", StartProjectCopy.live(read, false)?.text("itemId"))
        assertNull("a started project has nothing to start", StartProjectCopy.live(read, true))
        assertNull("and a project nobody could read is not one to offer a start to", StartProjectCopy.live(read, null))
        assertNull(StartProjectCopy.live(null, false))
        assertNull("no request, no card — however many tasks the project holds", StartProjectCopy.live(openItems(null), false))
    }

    @Test fun aDeliveredCardGoesStaleWhenItsRequestNoLongerStands() {
        val read = openItems(requestRow("item-1"))
        val asked = StartProjectCopy.request(read.obj("startRequest"))!!
        fun confirmation(digest: String) = j("""{"state":"UNCONFIRMED","confirmed":false,"currentVersion":{"digest":"$digest","material":[]}}""")
        fun standingOf(item: String, items: JsonObject?, confirmed: JsonObject?, started: Boolean?) = StartProjectCopy.standing(item, asked, items, confirmed, started)
        assertEquals(StartProjectCopy.Standing.LIVE, standingOf("item-1", read, confirmation(seal), false))
        // Replaced by a newer request, withdrawn, or naming a seal the criteria have moved past.
        assertEquals(StartProjectCopy.Standing.GONE, standingOf("item-0", read, confirmation(seal), false))
        assertEquals(StartProjectCopy.Standing.GONE, standingOf("item-1", openItems(null), confirmation(seal), false))
        assertEquals(StartProjectCopy.Standing.GONE, standingOf("item-1", read, confirmation(moved), false))
        // A read that has not answered names no version to start on.
        assertEquals(StartProjectCopy.Standing.UNREAD, standingOf("item-1", null, confirmation(seal), false))
        assertEquals(StartProjectCopy.Standing.UNREAD, standingOf("item-1", read, null, false))
        assertEquals(StartProjectCopy.Standing.UNREAD, standingOf("item-1", read, confirmation(seal), null))

        assertNull(StartProjectCopy.staleExplanation(StartProjectCopy.Standing.LIVE))
        assertEquals(StartProjectCopy.requestGone, StartProjectCopy.staleExplanation(StartProjectCopy.Standing.GONE))
        assertEquals(StartProjectCopy.unreadSeal, StartProjectCopy.staleExplanation(StartProjectCopy.Standing.UNREAD))
        assertTrue(StartProjectCopy.isOpen(StartProjectCopy.Standing.LIVE))
        assertTrue("a failed read is this device's problem, not an answer", StartProjectCopy.isOpen(StartProjectCopy.Standing.UNREAD))
        assertFalse("a request that no longer stands is not pointed at", StartProjectCopy.isOpen(StartProjectCopy.Standing.GONE))
    }
}
