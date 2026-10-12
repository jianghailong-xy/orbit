package io.orbitd.android.tasks

import io.orbitd.android.core.cards.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant
import java.time.ZoneOffset
import java.util.Locale

/** OrbitKit's task rules (TaskListLogicTests, TaskDetailLogicTests, TaskReopenTests, TaskRunHandoffTests,
 * TaskJudgmentTests) restated over the server's own JSON rows. */
class TaskLogicTest {
    private fun task(extra: String = "") = json("""{"id":"t","title":"T","status":"OPEN"$extra}""")

    @Test fun aLiveRunWinsOverTheLifecycleLabel() {
        assertEquals(TaskPill(PillKind.RUNNING, "Running"), TaskListLogic.pill(task(""","status":"DONE","running":true,"queued":true""")))
        assertEquals(TaskPill(PillKind.QUEUED, "Queued"), TaskListLogic.pill(task(""","queued":true""")))
        assertEquals(TaskPill(PillKind.RUNNING, "Running"), TaskListLogic.pill(task(""","sessions":[{"id":"s","runState":"RUNNING"}]""")))
        assertEquals(TaskPill(PillKind.QUEUED, "Queued"), TaskListLogic.pill(task(""","sessions":[{"id":"s","status":"PENDING"}]""")))
        assertEquals(TaskPill(PillKind.IN_PROGRESS, "In progress"), TaskListLogic.pill(task(""","status":"IN_PROGRESS"""")))
        assertEquals("Open", TaskListLogic.pill(task(""","status":"FUTURE_STATUS"""")).label)
    }

    @Test fun readyFollowsTheServerAndAGateRowNeverStarts() {
        assertFalse(TaskListLogic.canStart(task(""","runnable":true,"completionPolicy":"VERIFICATION_PASSED"""")))
        assertTrue(TaskListLogic.canStart(task(""","runnable":true,"status":"DONE"""")))
        assertFalse(TaskListLogic.canStart(task(""","runnable":false,"assignee":{"id":"a","runner":{"id":"r"}}""")))
        assertTrue(TaskListLogic.canStart(task(""","assignee":{"id":"a","runner":{"id":"r"}}""")))
        assertFalse(TaskListLogic.canStart(task(""","assignee":{"id":"a"}""")))
        assertFalse(TaskListLogic.canStart(task(""","dependencyState":"BLOCKED""""), assigneeHasRunner = true))
        assertFalse(TaskListLogic.canStart(task(""","dependsOn":[{"dependsOnTask":{"id":"p","status":"OPEN"}}]"""), assigneeHasRunner = true))
        // A check row is not a gate row: it has work of its own.
        assertFalse(TaskJudgment.isGateRow(task(""","completionPolicy":"VERIFICATION_PASSED","verifiesTaskId":"x"""")))
    }

    @Test fun aRowSaysTheFirstTrueThingThenItsAssignee() {
        val utc = ZoneOffset.UTC
        assertEquals(TaskRowPhrase.WaitingForConfirmation, TaskListLogic.rowPhrase(task(""","awaitingOwnerConfirmation":true,"dependencyState":"BLOCKED"""")))
        assertEquals(TaskRowPhrase.UnderReview, TaskListLogic.rowPhrase(task(""","confirmationUnderReview":true""")))
        assertEquals(TaskRowPhrase.PrerequisiteCancelled, TaskListLogic.rowPhrase(task(""","dependencyState":"BLOCKED_FAILED"""")))
        assertEquals(TaskRowPhrase.WaitingForPrerequisites, TaskListLogic.rowPhrase(task(""","blocked":true""")))
        val starts = TaskListLogic.rowPhrase(task(""","runAt":"2030-09-26T04:48:00.000Z""""), utc, Locale.US) as TaskRowPhrase.Starts
        assertTrue(starts.local.startsWith("Sep 26, 4:48"))
        assertNull(TaskListLogic.rowPhrase(task(""","status":"DONE","runAt":"2030-09-26T04:48:00.000Z"""")))
        assertEquals("Unassigned", TaskListLogic.phraseText(task(), null))
        assertEquals("Ada", TaskListLogic.phraseText(task(""","assignee":{"id":"a","name":"Ada"}"""), null))
        assertEquals("Prerequisite cancelled — resolve it", TaskListLogic.phraseText(task(), TaskRowPhrase.PrerequisiteCancelled))
    }

    @Test fun emptyPagesAndTabsReadAsTheBrowserDoes() {
        assertEquals(TaskListCopy.noneReady, TaskListLogic.emptyTitle(null, TaskFilter.RUNNABLE))
        assertEquals(TaskListCopy.noneRunning, TaskListLogic.emptyTitle("list", TaskFilter.RUNNING))
        assertEquals(TaskListCopy.noneInList, TaskListLogic.emptyTitle("list", TaskFilter.ALL))
        assertEquals(TaskListCopy.noneUnlisted, TaskListLogic.emptyTitle("none", TaskFilter.DONE))
        assertEquals(TaskListCopy.noneYet, TaskListLogic.emptyTitle(null, TaskFilter.ALL))
        assertFalse(TaskFilter.CANCELLED in TaskListLogic.availableFilters(TaskOverview(), TaskFilter.ALL))
        assertTrue(TaskFilter.CANCELLED in TaskListLogic.availableFilters(TaskOverview(cancelled = 1), TaskFilter.ALL))
        assertTrue(TaskFilter.CANCELLED in TaskListLogic.availableFilters(TaskOverview(), TaskFilter.CANCELLED))
        assertTrue(TaskListLogic.pinsHappeningNow(TaskFilter.ALL, null, emptyList()))
        assertFalse(TaskListLogic.pinsHappeningNow(TaskFilter.ALL, null, listOf("a")))
        assertFalse(TaskListLogic.pinsHappeningNow(TaskFilter.FAILED, null, emptyList()))
        assertEquals(TaskFilter.ALL, TaskFilter.remembered(null)); assertEquals(TaskFilter.DONE, TaskFilter.remembered("DONE"))
        assertTrue(TaskListLogic.isProjectOnlyList(json("""{"_count":{"tasks":3},"tasksOutsideProjects":0}""")))
        assertFalse(TaskListLogic.isProjectOnlyList(json("""{"_count":{"tasks":0},"tasksOutsideProjects":0}""")))
        assertFalse(TaskListLogic.isProjectOnlyList(json("""{"_count":{"tasks":3}}""")))
    }

    @Test fun statusSortRanksLiveWorkFirstAndTitlesCompareNumbers() {
        val rows = listOf(task(""","id":"done","status":"DONE""""), task(""","id":"run","running":true"""), task(""","id":"open""""),
            task(""","id":"failed","status":"FAILED""""), task(""","id":"queued","queued":true"""), task(""","id":"cancel","status":"CANCELLED""""),
            task(""","id":"prog","status":"IN_PROGRESS""""))
        assertEquals(listOf("run", "queued", "prog", "failed", "open", "done", "cancel"), TaskListLogic.sorted(rows, TaskSort.STATUS, false).map { it.text("id") })
        val titles = listOf("Task 10", "task 2", "Task 1").map { json("""{"id":"$it","title":"$it"}""") }
        assertEquals(listOf("Task 1", "task 2", "Task 10"), TaskListLogic.sorted(titles, TaskSort.TITLE, false).map { it.text("title") })
        val same = listOf(json("""{"id":"a","createdAt":"x"}"""), json("""{"id":"b","createdAt":"x"}"""))
        assertEquals(listOf("a", "b"), TaskListLogic.sorted(same, TaskSort.CREATED, true).map { it.text("id") })
    }

    @Test fun theActionRowConcludesOnTheLeftAndMovesOnTheRight() {
        val run = TaskRunHandoff.entry(task())
        assertEquals(TaskActionRow(null, TaskActionRow.Trailing.RunNow), TaskDetailLogic.actionRow(null, false, "OPEN", false, run))
        assertEquals(TaskActionRow(TaskActionRow.Leading.Reopen, null), TaskDetailLogic.actionRow(null, true, "DONE", false, run))
        assertEquals(TaskActionRow.Trailing.Retry, TaskDetailLogic.actionRow(null, true, "FAILED", false, TaskRunHandoff.entry(task(""","status":"FAILED""""))).trailing)
        val busy = TaskRunHandoff.entry(task(""","sessions":[{"id":"run","status":"RUNNING"}]"""))
        assertEquals(TaskActionRow.Trailing.OpenRun("run"), TaskDetailLogic.actionRow(null, false, "OPEN", false, busy).trailing)
        assertEquals(TaskActionRow.Trailing.Gate, TaskDetailLogic.actionRow(null, false, "OPEN", true, busy).trailing)
        val waiting = TaskDetailLogic.actionRow(OwnerPanelAction.Pointer("run"), false, "IN_PROGRESS", false, busy)
        assertEquals(TaskActionRow.Leading.Waiting("run"), waiting.leading); assertTrue(waiting.stacked)
        assertEquals(TaskActionRow.Leading.ConfirmDone, TaskDetailLogic.actionRow(OwnerPanelAction.Confirm, true, "OPEN", false, run).leading)
        assertEquals(TaskDetailCopy.runDisabledNoRunner, TaskDetailLogic.runDisabledHint(task(""","assignee":{"id":"a"}"""), false))
        assertEquals(TaskJudgmentCopy.verificationSubjectHint["RUNNING"], TaskDetailLogic.runDisabledHint(
            task(""","completionPolicy":"VERIFICATION_PASSED","verificationState":"RUNNING""""), true))
    }

    @Test fun ownerConfirmationIsOnePlaceToAnswer() {
        val owned = task(""","completionCriterion":"OWNER_CONFIRMED"""")
        assertEquals(OwnerPanelAction.Pointer("run"), OwnerConfirmations.panelAction(json("""{"waiting":{"sessionId":"run","requestId":"r"}}"""), owned))
        assertEquals(OwnerPanelAction.UnderReview("run"), OwnerConfirmations.panelAction(
            json("""{"waiting":{"sessionId":"run","requestId":"r","review":{"state":"UNDER_REVIEW"}}}"""), owned))
        assertEquals(OwnerPanelAction.Confirm, OwnerConfirmations.panelAction(json("""{"completionCriterion":"OWNER_CONFIRMED","status":"IN_PROGRESS","waiting":null}"""), owned))
        assertNull(OwnerConfirmations.panelAction(json("""{"completionCriterion":"OWNER_CONFIRMED","status":"FAILED","waiting":null}"""), owned))
        assertNull(OwnerConfirmations.panelAction(json("""{"completionCriterion":"EVIDENCE_JUDGMENT","status":"OPEN","waiting":null}"""), owned))
        // Unread: only a task with no runs may confirm from its own row.
        assertEquals(OwnerPanelAction.Confirm, OwnerConfirmations.panelAction(null, owned))
        assertNull(OwnerConfirmations.panelAction(null, task(""","completionCriterion":"OWNER_CONFIRMED","sessions":[{"id":"s"}]""")))
    }

    @Test fun attributionSaysFactsOrWhyThereAreNoneInTheBrowsersWords() {
        val rows = TaskDetailLogic.attributionRows(json("""{"taskId":"t","owning":null,"owningAbsentReason":"FILED_UNDER_NO_PROJECT",
            "discovery":{"project":null,"triggerEvent":null,"task":null,"session":null,"recorded":false,"absentReason":"NO_DISCOVERY_RECORDED","authority":"EVIDENCE_ONLY"},
            "crossing":{"state":"PENDING","from":{"projectId":"p1","title":"From","status":"OPEN"},"to":{"projectId":"p2","title":"To","status":"OPEN"},"code":"CROSS_PROJECT_APPROVAL_REQUIRED","requiredAction":"ANSWER"},
            "crossingAbsentReason":null,"blocker":{"blockerId":"b","kind":"AWAITING_USER_APPROVAL","owner":"USER","requiredAction":"Decide","nextCheckAt":"2030-09-26T04:48:00.000Z","code":null},
            "blockerAbsentReason":null}"""), ZoneOffset.UTC, Locale.US)
        assertEquals(listOf("Counts towards", "Noticed in", "Crossing", "Blocked by"), rows.map { it.label })
        assertEquals("This task is filed under no project.", rows[0].text); assertTrue(rows[0].absent)
        assertEquals("Nothing was recorded about where this work was noticed.", rows[1].text)
        assertEquals("Waiting for your answer", rows[2].text)
        assertEquals(listOf("the work is not filed anywhere until you answer", "From → To", "CROSS_PROJECT_APPROVAL_REQUIRED ANSWER"), rows[2].notes)
        assertEquals("Decide", rows[3].text); assertEquals(listOf("AWAITING_USER_APPROVAL"), rows[3].tags)
        assertEquals("UNKNOWN · owner USER", rows[3].notes[0]); assertTrue(rows[3].notes[1].startsWith("Next checked Sep 26, 4:48"))
        val noticed = TaskDetailLogic.attributionRows(json("""{"owning":{"projectId":"p","title":"Launch","status":"OPEN"},
            "discovery":{"project":{"projectId":"p","title":"Launch","status":"OPEN"},"triggerEvent":"coordinator.session_filed","task":null,
            "session":{"sessionId":"s","title":null},"recorded":true,"absentReason":null,"authority":"EVIDENCE_ONLY"},"crossing":null,"crossingAbsentReason":null,
            "blocker":null,"blockerAbsentReason":"NOTHING_BLOCKING_ATTRIBUTION"}"""))
        assertEquals("Launch", noticed[0].text); assertEquals("project" to "p", noticed[0].link)
        assertEquals("Launch", noticed[1].text); assertEquals(listOf("EVIDENCE ONLY"), noticed[1].tags)
        assertEquals(listOf("Trigger coordinator.session_filed", "Session: untitled"), noticed[1].notes); assertEquals("session" to "s", noticed[1].link)
        assertEquals("Not reported by this server build.", noticed[2].text)
        assertEquals("Nothing is blocking where this work counts.", noticed[3].text)
    }

    /** A request to move this task reads as a move (iOS 779471b97, TaskDetailLogicTests): the task stays in its project until the
     * owner answers, which a filing's "not filed anywhere" would deny; a filing and a dependency keep their words. */
    @Test fun aMoveRequestIsReadAsAMove() {
        fun notes(kind: String?, state: String) = TaskDetailLogic.attributionRows(json("""{"owning":null,"owningAbsentReason":"FILED_UNDER_NO_PROJECT",
            "discovery":null,"crossing":{${kind?.let { "\"kind\":\"$it\"," } ?: ""}"state":"$state","from":{"projectId":"p1","title":"From","status":"OPEN"},
            "to":{"projectId":"p2","title":"To","status":"OPEN"},"code":null,"requiredAction":null},"blocker":null}"""), ZoneOffset.UTC, Locale.US)[2].notes
        assertEquals(listOf("the task stays in its project until you answer, and confirming moves it", "From → To"), notes("MOVE_TASK", "PENDING"))
        assertEquals("the task has not moved: this yes was recorded without moving it", notes("MOVE_TASK", "APPROVED").first())
        assertEquals("refusing is final for this request, and the task stays where it is", notes("MOVE_TASK", "DENIED").first())
        assertEquals("the task was moved when this request was confirmed", notes("MOVE_TASK", "APPLIED").first())
        for (kind in listOf("FILE_TASK", "DEPEND_ON_TASK", null)) assertEquals("the work is not filed anywhere until you answer", notes(kind, "PENDING").first())
    }

    @Test fun dependenciesShowTheComponentOrTheDirectEdgesUntilItArrives() {
        val detail = json("""{"id":"t","title":"Current","status":"OPEN","dependencyState":"BLOCKED",
            "dependsOn":[{"dependsOnTask":{"id":"p","title":"Before","status":"DONE"}},{"dependsOnTask":{"id":"q","title":"Other","status":"OPEN"}}],
            "dependedOnBy":[{"task":{"id":"n","title":"After","status":"OPEN"}}]}""")
        val direct = TaskDetailLogic.dependencyGraph(detail, null)
        assertEquals(listOf("t", "p", "q", "n"), direct.objects("nodes").map { it.text("id") })
        assertEquals("3 connected · 2 upstream · 1 downstream", TaskDetailLogic.dependencySummary(detail, direct))
        assertEquals("1 of 2 direct prerequisites complete. All are required." to false, TaskDetailLogic.blockedNotice(detail))
        val rows = TaskDetailLogic.dependencyRows(direct)
        assertEquals("Depends on Before, Other · Required by After", rows.first { it.isFocus }.relationships)
        assertTrue(rows.first { it.id == "p" }.removable); assertFalse(rows.first { it.id == "n" }.removable)
        assertEquals("Required by Current", rows.first { it.id == "p" }.relationships)
        assertTrue(TaskDetailLogic.prefersGraph(direct))
        val loaded = json("""{"focusTaskId":"t","nodes":[{"id":"t","title":"Current","status":"OPEN"}],"edges":[],"counts":{"upstream":7,"downstream":9},"truncated":true}""")
        assertSame(loaded, TaskDetailLogic.dependencyGraph(detail, loaded))
        assertEquals("0 connected loaded · 7 upstream · 9 downstream", TaskDetailLogic.dependencySummary(detail, loaded))
        val marks = TaskDetailLogic.graphMarks(direct)
        assertEquals(4, marks.objects("marks").size); assertEquals("p", marks.objects("edges").first().text("sourceMarkId"))
        assertEquals(TaskDetailCopy.graphLimitReached, TaskDetailLogic.truncationNotice(json("""{"collapsedGroups":[{"hiddenCount":2}]}""")))
        assertTrue(TaskDetailLogic.truncationNotice(json("""{"collapsedGroups":[{"hiddenCount":2,"cursor":"c"}],"limits":{"maxNodes":500}}"""))!!.contains("500 tasks"))
    }

    @Test fun acceptanceSavesOnlyWhatMovedAndTheCommandTravelsWithItsExitCode() {
        val current = AcceptanceDraft(json("""{"acceptanceCriteria":"Before","acceptanceCommand":"check","acceptanceExpectedExitCode":0}"""))
        assertEquals(json("""{"acceptanceCriteria":"After"}"""), AcceptanceDraft("After", "check", "0").patch(current))
        assertEquals(json("""{"acceptanceCommand":null,"acceptanceExpectedExitCode":null}"""), AcceptanceDraft("Before", "", "").patch(current))
        assertEquals(json("""{"acceptanceCriteria":null}"""), AcceptanceDraft("  ", "check", "0").patch(current))
        assertEquals(TaskDetailCopy.acceptancePairIncomplete, AcceptanceDraft("x", "check", "").problem)
        assertEquals(TaskDetailCopy.acceptanceExitCodeNotAnInteger, AcceptanceDraft("x", "check", "1.0").problem)
        assertNull(AcceptanceDraft("x", "check", "-1").problem)
        assertFalse(AcceptanceDraft("Before", "check", "0").canSave(current))
    }

    @Test fun reopenAsksTheQuestionWithOnlyTheSentencesThatAreTrue() {
        assertEquals(listOf(TaskReopenCopy.modalBody), TaskReopen.paragraphs(task()))
        assertEquals(listOf(TaskReopenCopy.modalBody, TaskReopenCopy.modalProject, TaskReopenCopy.modalRetired),
            TaskReopen.paragraphs(task(""","projectId":"p","terminalReason":"SUPERSEDED"""")))
        assertTrue(TaskReopen.isOffered(task(""","status":"FAILED"""")) && !TaskReopen.isOffered(task()))
    }

    @Test fun copyAsMarkdownSaysWhatThePanelSays() {
        val md = TaskMarkdown.task(json("""{"id":"t","title":"Ship","status":"OPEN","completionCriterion":"EVIDENCE_JUDGMENT","acceptanceCriteria":"It ships.",
            "acceptanceCommand":"make check","acceptanceExpectedExitCode":0,"dependsOn":[{"dependsOnTask":{"id":"p","title":"Build","status":"DONE"}}],
            "sessions":[{"id":"s","runState":"SUCCEEDED","createdAt":"2030-01-01T00:00:00Z","agent":{"name":"Ada"}}]}"""), "https://o/tasks/t") { "Jan 1" }
        assertEquals("# Ship\n\n**Status:** Open · Judged by submitted evidence\n**Link:** https://o/tasks/t\n\n## Acceptance\n\nIt ships.\n\n" +
            "Command: `make check` — done when it exits `0`\n\n## Dependencies\n\n- Needs: Build — Done\n\n## Runs\n\n1 run\n\n- Succeeded · Jan 1 · Ada\n", md)
    }

    @Test fun followConditionsReadAsWatchProjectionWritesThem() {
        assertEquals(listOf("The task finishes", "The task finishes, or the task fails", "The task is done", "The task fails"),
            TaskFollow.conditions.map { TaskFollow.condition(it) })
        assertEquals("1 hour", TaskFollow.deadlineTitle(3600)); assertEquals("30 days", TaskFollow.deadlineTitle(2_592_000))
        val (live, ended) = TaskDetailLogic.followers("t", listOf(
            json("""{"id":"w1","state":"ACTIVE","targets":[{"targetKind":"TASK","targetResourceId":"t"}]}"""),
            json("""{"id":"w2","state":"MATCHED","targets":[{"targetKind":"TASK","targetResourceId":"t"}]}"""),
            json("""{"id":"w3","state":"ACTIVE","targets":[{"targetKind":"SESSION","targetResourceId":"t"}]}""")))
        assertEquals(listOf("w1"), live.map { it.text("id") }); assertEquals(1, ended)
    }

    /** ModelRoutingLogicTests after iOS 9fb3ae6ee: with the account's switch off (the default) a run has no route, and what it ran on
     * is its own row's — a pick it never took is not said; on, the applied pick fills in for a run not claimed yet. */
    @Test fun aRunsRouteIsReadOnlyWhileTheAccountsSwitchIsOn() {
        val routed = json("""{"id":"s1","route":{"level":"M","applied":true,"model":"claude-sonnet-5-5","effort":"medium"}}""")
        val shadow = json("""{"id":"s2","model":"claude-opus-5-5","effort":"high","route":{"level":"L","applied":false,"model":"claude-sonnet-5-5"}}""")
        val noTier = json("""{"id":"s3","route":{"level":"","applied":true,"model":"x"}}""")
        assertNull(TaskDetailLogic.runRoute(routed, smartSelection = false))
        assertNull(TaskDetailLogic.runRoute(shadow, smartSelection = false))
        assertEquals("M", TaskDetailLogic.runRoute(routed, smartSelection = true)?.text("level"))
        assertNull("a route with no tier routed nothing", TaskDetailLogic.runRoute(noTier, smartSelection = true))
        val name: (String) -> String = { it }
        assertNull("off: nothing the run's own row doesn't say", TaskDetailLogic.runModelLine(routed, smartSelection = false, modelLabel = name))
        assertEquals("claude-sonnet-5-5 · medium", TaskDetailLogic.runModelLine(routed, smartSelection = true, modelLabel = name))
        assertEquals("claude-opus-5-5 · high", TaskDetailLogic.runModelLine(shadow, smartSelection = false, modelLabel = name))
        assertEquals("claude-opus-5-5 · high", TaskDetailLogic.runModelLine(shadow, smartSelection = true, modelLabel = name))
    }

    @Test fun smallWordsAndNumbers() {
        assertEquals("512 B", TaskDetailLogic.humanSize(512)); assertEquals("2 KB", TaskDetailLogic.humanSize(2048)); assertEquals("1.5 MB", TaskDetailLogic.humanSize(1572864))
        assertTrue(TaskDetailLogic.folds("x".repeat(601))); assertTrue(TaskDetailLogic.folds((1..11).joinToString("\n"))); assertFalse(TaskDetailLogic.folds("short"))
        assertEquals("No suggestion", TaskDetailLogic.modelHintPicks(emptyList()).first().label)
        assertEquals(listOf("S", "M", "L", "XL"), TaskDetailLogic.modelHintPicks(emptyList()).drop(1).map { it.label })
        assertEquals("M · Sonnet 5.5 · medium", TaskDetailLogic.modelHintLabel("M", listOf(json("""{"level":"M","label":"Sonnet 5.5","effort":"medium"}"""))))
        assertEquals(json("""{"modelHint":null,"modelHintReason":null}"""), TaskDetailLogic.modelHintRequest(null))
        assertEquals("Coordinator: Needs care", TaskDetailLogic.modelHintNote(task(""","modelHint":"L","modelHintReason":"Needs care"""")))
        assertEquals("12m", TaskTime.elapsed("2030-01-01T00:00:00Z", Instant.parse("2030-01-01T00:12:30Z")))
        assertEquals("3h ago", TaskTime.relative("2030-01-01T00:00:00Z", Instant.parse("2030-01-01T03:10:00Z")))
        assertEquals("Created by Ada", TaskDetailLogic.createdFootnote("Ada", null))
        assertEquals(TaskDetailCopy.scheduleNotSet, TaskDetailLogic.scheduleValue(null))
        assertEquals(TaskDetailCopy.scheduleHintUnreadable, TaskDetailLogic.scheduleHint("not a time"))
        assertEquals(listOf("ws1"), mentionedWorkspaceIds("hi @Ada", listOf(json("""{"id":"ws1","name":"ada"}"""), json("""{"id":"ws2","name":"Adam"}"""))))
        assertEquals(emptyList<String>(), mentionedWorkspaceIds("mail@Ada", listOf(json("""{"id":"ws1","name":"Ada"}"""))))
    }

    /** A task's run pins (board 6; docs/provider-engine-contract.md §1.2, §3.5): the Engine row pins an engine, keeping a pinned
     * credential only where the new engine runs it; the Provider row pins a credential with the engine it runs on here, or takes
     * it back to the engine's default; Assignee's takes every pin back. The model pin goes with every move. */
    @Test fun theEnginePinComesFirstAndAProviderIsPinnedWithItsEngine() {
        val deepSeek = listOf("claude", "opencode", "dsh")
        assertEquals(TaskPin(TaskPin.Pin("dsh")), TaskPins.engine("dsh", null, null, emptyList()))
        assertEquals("a DeepSeek key Harness runs stays pinned", TaskPin(TaskPin.Pin("dsh")), TaskPins.engine("dsh", "claude", "deepseek", deepSeek))
        assertEquals("a GLM key Harness can't run gives way to the engine's default",
            TaskPin(TaskPin.Pin("dsh"), TaskPin.Pin(null)), TaskPins.engine("dsh", "claude", "glm", listOf("claude", "opencode")))
        assertEquals(TaskPin(TaskPin.Pin(null), TaskPin.Pin(null)), TaskPins.engine(null, "dsh", "deepseek", deepSeek))
        assertNull(TaskPins.engine("dsh", "dsh", "deepseek", deepSeek))
        assertNull(TaskPins.engine(null, null, null, emptyList()))
        assertEquals(TaskPin(TaskPin.Pin("dsh"), TaskPin.Pin("deepseek-2")), TaskPins.provider("deepseek-2", "deepseek", "dsh"))
        assertEquals("Engine default", TaskPin(provider = TaskPin.Pin(null)), TaskPins.provider(null, "deepseek-2", "dsh"))
        assertNull(TaskPins.provider(null, null, "dsh"))
        assertNull(TaskPins.provider("deepseek-2", "deepseek-2", "dsh"))
        // On the wire: a pin left out stays, null takes it back, and the model always goes.
        assertEquals(json("""{"engine":"dsh","provider":null,"model":null}"""), TaskPin(TaskPin.Pin("dsh"), TaskPin.Pin(null)).request())
        assertEquals(json("""{"engine":"dsh","model":null}"""), TaskPin(TaskPin.Pin("dsh")).request())
        assertEquals(json("""{"provider":null,"model":null}"""), TaskPin(provider = TaskPin.Pin(null)).request())
    }
}
