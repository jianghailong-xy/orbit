package io.orbitd.android.increments

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.orbitd.android.navigation.ObjectId
import java.time.Instant
import okhttp3.mockwebserver.MockResponse
import org.junit.Test
import org.junit.runner.RunWith

/**
 * A11 increments on a device, over the test's own fixture: a project "Launch" in workspace Alpha whose pages draw what each row needs
 * — its ending once it is DONE (A11-14), the project page's coordinator card in each of its states (A11-16), the merge check card's
 * pass line (A11-17), a task page's Run hint (A11-18), the sessions page's Landings row and the window it opens (A11-21), and the
 * project page's card for a lone merge job (A11-22). The shapes are the ones the JVM tests serve (ProjectShellFixture, ProjectPageTest,
 * ProjectMergeCopyTest, LandingEntriesShellTest, ProjectLandingCardViewTest, TaskLogicTest).
 */
@RunWith(AndroidJUnit4::class)
class ProjectIncrementsDeviceTest : IncrementDeviceTest() {
    private val launch = "34A15cProjectLaunch001"
    private val coord = "34A15cSessionCoord0002"
    private val worker = "34A15cSessionWorker002"
    private val shipped = "34A15cSessionShipped02"
    private val lone = "34A15cTaskLoneRun00001"
    private val chained = "34A15cTaskChained00001"
    private val landingAwait = "34A15cLandingAwait0001"
    private val landingOld = "34A15cLandingLanded001"
    private val landingCancelled = "34A15cLandingCancel001"
    private val mergeLanding = "34A15cLandingMerge0001"
    override val ids get() = listOf(workspace, runner, launch, coord, worker, shipped, lone, chained, landingAwait, landingOld, landingCancelled, mergeLanding)

    /** The project's state for the test: OPEN (started), or DONE as the server derived it. */
    @Volatile private var done = false
    /** What GET …/coordinator/status answers. */
    @Volatile private var coordinator = """{"projectId":"$launch","readAt":"${Instant.now()}","state":"NEVER_OPENED","coordination":null}"""
    /** What GET …/integration answers. */
    @Volatile private var integration = """{"line":"PROJECT_BRANCH","ref":"project/launch","integratingCount":0,"queuedCount":0,"inFlight":null}"""
    /** What GET …/promotions/current answers: an empty 200 (no candidate) or a candidate. */
    @Volatile private var promotion: String? = null
    /** Landing rows riding on the project's member reads (A11-21). */
    @Volatile private var landings = false

    private fun membership(role: String) = """"projectId":"$launch","projectMembership":{"projectId":"$launch","projectTitle":"Launch",
        "projectStatus":"${if (done) "DONE" else "OPEN"}","role":"$role"}"""
    private fun row(id: String, title: String, run: String, extra: String, lifecycle: String = "OPEN", lastTurn: String = ago(5)) =
        """{"id":"$id","title":"$title","status":"$run","runState":"$run","lifecycleState":"$lifecycle","agent":{"id":"$workspace","name":"Alpha"},
        "agentId":"$workspace","createdAt":"${ago(600)}","lastTurnAt":"$lastTurn","pendingApprovals":0,"tags":[],
        "capabilities":{"canComplete":${lifecycle == "OPEN"},"canRestore":${lifecycle != "OPEN"}}$extra}"""
    private fun coordRow() = row(coord, "Coordinate launch", "AWAITING_INPUT", ""","lastAssistantText":"Planning the release",${membership("COORDINATOR")}""", lastTurn = ago(30))
    private fun workerRow() = row(worker, "Wire tests", "RUNNING", ""","lastToolUse":"Bash",${membership("TASK")}""", lastTurn = ago(2))
    private fun shippedRow() = row(shipped, "Shipped docs", "SUCCEEDED", ""","completedAt":"${ago(2880)}",${membership("TASK")}""", "COMPLETED", ago(2880))

    private fun landingRow(id: String, title: String, created: String, state: String, settledAs: String?, settledAt: String?) =
        """{"id":"$id","title":"$title","status":"AWAITING_INPUT","createdAt":"$created","lastTurnAt":"$created","sessionKind":"LANDING",
        "landing":{"subject":"TASK","state":"$state","settledAs":${settledAs?.let { "\"$it\"" } ?: "null"},"settledAt":${settledAt?.let { "\"$it\"" } ?: "null"}},
        "projectMembership":{"projectId":"$launch","projectTitle":"Launch","projectStatus":"OPEN","role":"LANDING"}}"""
    private fun landingRows() = if (!landings) emptyList() else listOf(
        landingRow(landingAwait, "Land · stopped", ago(42), "AWAITING_DECISION", null, null),
        landingRow(landingOld, "Land · old", ago(2880), "SETTLED", "LANDED", ago(2880)),
        landingRow(landingCancelled, "Land · cancelled", ago(4320), "SETTLED", "CANCELLED", ago(4320)))

    override fun sessions(view: String, project: String?): String = when (view) {
        "open" -> (listOf(coordRow(), workerRow()) + if (project != null) landingRows() else emptyList()).joinToString(",", "[", "]")
        "completed" -> (listOf(shippedRow()) + if (project != null) landingRows() else emptyList()).joinToString(",", "[", "]")
        else -> "[]"
    }

    private fun document() = if (done) """{"id":"$launch","title":"Launch","status":"DONE","goal":"Ship it.","createdAt":"2026-10-01T00:00:00Z",
        "_count":{"tasks":8},"startedAt":"2026-10-02T00:00:00Z","doneBy":"DERIVED","coordinatorSessionId":"$coord",
        "derivedDone":{"counts":{"criteria":6,"met":6,"landed":6,"onMain":5,"byReason":{"IN_FLIGHT":0,"ON_PROJECT_BRANCH":0,"NOTHING_TO_LAND":0,"NO_RECEIPT":0,"CODELESS":1}},
        "status":"DONE","done":true,"withheld":[],"confirmation":"CONFIRMED",
        "criteria":[{"definitionId":"c1","satisfied":true,"landing":"LANDED","landingReason":null},{"definitionId":"c2","satisfied":true,"landing":"LANDED","landingReason":null},
        {"definitionId":"c3","satisfied":true,"landing":"LANDED","landingReason":null},{"definitionId":"c4","satisfied":true,"landing":"LANDED","landingReason":null},
        {"definitionId":"c5","satisfied":true,"landing":"LANDED","landingReason":null},{"definitionId":"c6","satisfied":true,"landing":"LANDED","landingReason":"CODELESS"}]},
        "acceptanceCriteriaItems":[]}"""
        else """{"id":"$launch","title":"Launch","status":"OPEN","goal":"Ship it.","createdAt":"2026-10-01T00:00:00Z","_count":{"tasks":8},
        "startedAt":"2026-10-02T00:00:00Z","coordinatorSessionId":"$coord","coordinatorEnabled":true,"configRevision":"3","maxConcurrentTasks":2,
        "exceptionEscalationSeconds":7200,"pausedAt":null,"integration":{"line":"PROJECT_BRANCH","ref":"project/launch","upstreamRef":"main","escalationSeconds":7200},
        "acceptanceCriteriaItems":[]}"""
    private fun sidebar() = if (done) "[]" else """[{"id":"$launch","title":"Launch","status":"OPEN","createdAt":"2026-10-01T00:00:00Z","buckets":{"running":1},
        "taskCounts":{"done":5,"failed":0,"total":8},"attention":{},"integration":{"line":"PROJECT_BRANCH","ref":"project/launch","activeJobCount":0},
        "startedAt":"2026-10-02T00:00:00Z","mainBranch":"main"}]"""
    private fun openItems() = if (!landings) """{"needsYou":[],"withCoordinator":[]}"""
        else """{"needsYou":[{"itemId":"item-holder","kind":"INTEGRATION_CHECK_FAILED","title":"Checks failed","waitingSince":"${ago(30)}",
        "assignee":"COORDINATOR","landingSessionId":"$landingAwait"}],"withCoordinator":[]}"""
    private fun landingDetail(id: String) = """{"id":"$id","title":"Land · Wire the page","status":"AWAITING_INPUT","sessionKind":"LANDING",
        "workspace":null,"assignedRunner":null,"tags":[],"landing":{"sessionId":"$id","projectId":"$launch","subject":"TASK","taskId":"t-landing",
        "promotionId":null,"episode":1,"openedAt":"${ago(600)}","settledAt":null,"settledAs":null,"checks":[],
        "currentAttempt":{"jobId":"j-1","kind":"LAND_TASK","state":"RUNNING","generation":1,"phase":"CHECK","round":1,"step":null,"claim":1,
        "runnerName":"wikova","sourceSessionId":"$id","targetRef":"refs/heads/project/launch","startedAt":"${ago(110)}","heartbeatAt":"${ago(0)}",
        "outputMovedAt":"${ago(6)}","progressProtocol":"v2","check":{"name":"TASK_ACCEPTANCE","index":1,"count":3,"budgetSeconds":3600,"startedAt":"${ago(110)}"},
        "liveness":"LIVE","blockingReason":null,"timedOut":false,"limitSeconds":600,"retryable":false,"pushBoundaryPassed":false},"todos":[],"generations":[]}}"""

    /** A task with no project, no prerequisite and no run time: nothing but Run starts it (A11-18); [chained] waits on a prerequisite. */
    private fun task(id: String) = """{"id":"$id","title":"${if (id == lone) "Draft the release notes" else "Publish the release notes"}","status":"OPEN",
        "createdAt":"${ago(120)}","updatedAt":"${ago(1)}","creatorName":"orbit-develop","autoRunWhenReady":false,"attachments":[],"sessions":[],
        "comments":[],"projectId":null,"runAt":null,"assignee":{"id":"$workspace","name":"Alpha"},
        "dependsOn":${if (id == chained) """[{"dependsOnTask":{"id":"$lone","title":"Draft the release notes","status":"DONE"}}]""" else "[]"},"dependedOnBy":[]}"""

    override fun answer(req: Req): MockResponse? {
        val p = req.parts
        return when {
            req.path == "projects/sidebar" || req.path == "projects" -> json(sidebar())
            req.path == "sessions/$coord" && req.method == "GET" -> json(coordRow())
            req.path == "sessions/$coord/events/page" -> json(page(listOf(event(1, "user", """{"text":"Coordinate the launch."}"""))))
            p.size == 2 && p[0] == "sessions" && p[1] in listOf(landingAwait, landingOld, landingCancelled, mergeLanding) && req.method == "GET" -> json(landingDetail(p[1]))
            p[0] == "sessions" && (p.last() == "landing" || p.last() == "log") -> json("""{"jobId":"j-1","entries":[],"nextCursor":null}""")
            req.path == "tasks/t-landing" -> json("""{"id":"t-landing","title":"Wire the page"}""")
            p.size == 2 && p[0] == "tasks" && p[1] in listOf(lone, chained) -> json(task(p[1]))
            p.size >= 2 && p[0] == "projects" && p[1] == launch -> when (p.drop(2).joinToString("/")) {
                "" -> if (req.method == "GET") json(document()) else null
                "integration" -> json(integration)
                "open-items" -> json(openItems())
                "coordinator/status" -> json(coordinator)
                "coordinator" -> if (req.method == "POST") json("""{"sessionId":"$coord","created":false,"workspaceId":"$workspace"}""") else null
                "promotions/current" -> promotion?.let { json(it) } ?: empty200()
                "promotions/merged", "handoffs" -> json("[]")
                "acceptance/confirmation" -> json("""{"state":"CONFIRMED","confirmed":true,"currentVersion":{"digest":"seal-launch","material":[]}}""")
                "dependency-graph" -> json("""{"marks":[],"edges":[],"taskCount":0,"folded":false,"truncated":false}""")
                "panorama" -> json("""{"buckets":{"running":1,"ready":0,"blocked":0,"done":5,"integrating":0,"onIntegrationLine":1,"onUpstream":4,
                    "doneNotIntegrated":0,"awaitingVerification":0,"failed":0,"cancelled":0},"shape":{"taskCount":8,"edgeCount":0}}""")
                "tasks/page" -> json("""{"items":[],"nextCursor":null}""")
                else -> json("{}")
            }
            else -> null
        }
    }

    private fun openSessionsPage() {
        signIn()
        awaitTag("workspace:$workspace")
        compose.onNodeWithTag("workspace:$workspace").performClick()
        awaitTag("project-row:$launch")
        compose.onNodeWithTag("project-row:$launch").performClick()
        await("the project's sessions page") { exists(hasTestTag("project-sessions-list")) }
    }

    private fun scrollProject(matcher: SemanticsMatcher) {
        compose.onNode(hasTestTag("project-detail") and hasScrollAction()).performScrollToNode(matcher)
        settle()
    }

    /** A11-14: a done project's sessions page draws its ending where the progress card was. */
    @Test fun aDoneProjectsSessionsPageDrawsTheEndingCard() = journey {
        done = true
        openSessionsPage()
        awaitTag("project-sessions-ending-settled")
        verify("the ending says the project is done", says("project-sessions-ending-settled", "This project is done"))
        verify("and who recorded it", says("project-sessions-ending-settled", "recorded by Orbit"))
        verify("the tally counts the criteria", textOf("project-sessions-ending-settled-tally") == "6 criteria · 5 on main · 1 no code to land")
        verify("the progress card is not drawn beside it", !exists(hasTestTag("project-sessions-progress"), unmerged = true))
        verify("the project document was read for it", calls.any { it == "GET projects/$launch" })
        capture("01-done-project-ending")
        compose.onNodeWithTag("project-sessions-list").performScrollToNode(hasText("Shipped docs"))
        verify("its sessions are still listed under it", exists(hasText("Shipped docs"), unmerged = true))
        capture("02-done-project-members")
    }

    /** A11-16: the project page's coordinator card says Needs you only while requests wait, and its press says what it does. */
    @Test fun theCoordinatorCardsPillAndPressFollowTheServer() = journey {
        fun status(run: String, turn: Boolean, pending: Int) = """{"projectId":"$launch","readAt":"${Instant.now()}","state":"LIVE",
            "coordination":{"sessionId":"$coord","coordinatorGeneration":"0","session":{"id":"$coord","runState":"$run","lifecycleState":"OPEN",
            "engineTurnActive":$turn,"pendingApprovals":$pending}}}"""
        coordinator = status("AWAITING_INPUT", false, 2)
        signIn()
        open("orbit-project:$launch")
        await("the project page") { exists(hasTestTag("project-detail") and hasScrollAction()) }
        scrollProject(hasTestTag("project-coordinator"))
        await("the pill says Needs you") { textOf("coordinator-pill") == "Needs you" }
        verify("the press names the requests", says("project-coordinator", "Review 2 requests", substring = true))
        capture("01-coordinator-needs-you")
        coordinator = status("RUNNING", false, 0)
        await("the pill says Working after the next read", 45_000) { textOf("coordinator-pill") == "Working" }
        verify("with nothing pending the press opens the coordinator", says("project-coordinator", "Open coordinator", substring = true))
        capture("02-coordinator-working")
        coordinator = status("AWAITING_INPUT", false, 0)
        await("the pill says Idle after the next read", 45_000) { textOf("coordinator-pill") == "Idle" }
        capture("03-coordinator-idle")
        compose.onNodeWithTag("project-coordinator").performScrollTo().performClick()
        await("the coordinator is asked for") { calls.any { it == "POST projects/$launch/coordinator" } }
        await("the coordinator's conversation opens") { app.realtime.state.value.session?.id?.let { ObjectId.same(it, coord) } == true }
        capture("04-coordinator-opened")
    }

    /** A11-17: the merge check card says what a pass leads to, as the candidate says. */
    @Test fun theMergeCheckCardSaysWhatHappensWhenItPasses() = journey {
        integration = """{"line":"PROJECT_BRANCH","ref":"project/launch","integratingCount":1,"queuedCount":0,
            "inFlight":{"kind":"CHECK_PROMOTION","state":"RUNNING","phase":"CHECK","startedAt":"${ago(7)}","heartbeatAt":"${ago(0)}"}}"""
        fun candidate(onPass: String) = """{"promotionId":"pr-1","state":"CHECKING","onPass":"$onPass","sourceRef":"refs/heads/project/launch",
            "sourceSha":"5e5bfca23aa1","upstreamRef":"refs/heads/main","commitsAhead":5,"filesChanged":10,"taskIds":["t1","t2"],
            "tasks":[{"taskId":"t1","title":"Fix D1"},{"taskId":"t2","title":"Logs"}],"conflicts":[],"askedAt":"${ago(9)}","merged":null}"""
        promotion = candidate("MERGE")
        openSessionsPage()
        compose.onNodeWithTag("project-sessions-list").performScrollToNode(hasTestTag("project-merge-card:checking"))
        await("the pass line of an automatic merge") {
            exists(hasText("Merges on its own when it passes.") and hasAnyAncestor(hasTestTag("project-merge-card:checking")), unmerged = true)
        }
        verify("the card is the merge check's", textOf("landing-head:title") == "Merge check")
        capture("01-merge-check-merges")
        promotion = candidate("ASK")
        await("the pass line of a merge that asks", 30_000) {
            exists(hasText("Asks you when it passes.") and hasAnyAncestor(hasTestTag("project-merge-card:checking")), unmerged = true)
        }
        capture("02-merge-check-asks")
    }

    /** A11-18: a task nothing else will start says so beside Run; one with a prerequisite does not. */
    @Test fun theRunHintSaysNothingElseStartsTheTask() = journey {
        signIn()
        open("orbit-task:$lone")
        await("the task page") { exists(hasTestTag("task-detail") and hasScrollAction()) && exists(hasText("Draft the release notes"), unmerged = true) }
        awaitTag("task-run-hint")
        verify("the hint's words", textOf("task-run-hint") ==
            "Nothing starts this task by itself: auto-run needs a prerequisite or a project, and it has neither.")
        verify("Run is offered", exists(hasTestTag("task-run")))
        capture("01-run-hint")
        open("orbit-task:$chained")
        await("the chained task's page") { exists(hasText("Publish the release notes"), unmerged = true) }
        await("its own run controls") { exists(hasTestTag("task-run")) }
        verify("a task a prerequisite starts carries no hint", !exists(hasTestTag("task-run-hint"), unmerged = true))
        capture("02-no-hint-with-a-prerequisite")
    }

    /** A11-21, since revision 28 (owner 2026-10-27, docs/mocks/landings-one-window): the sessions page sums its landings up in one
     *  Landings row, which opens the project's Landings window — every settled one kept, in its day, and the waiting one under Now; a
     *  settled row opens in place to its record, read once. */
    @Test fun theLandingsRowOpensTheWindowWithEveryLandingInItsDay() = journey {
        landings = true
        openSessionsPage()
        val list = compose.onNodeWithTag("project-sessions-list")
        list.performScrollToNode(hasTestTag("landings-row"))
        verify("one Landings heading", count(hasText("Landings") and isHeading()) == 1)
        verify("one Landings row", count(hasTestTag("landings-row")) == 1)
        await("the row says what waits") { textOf("landings-row:line").startsWith("1 waiting for a decision") }
        verify("one waits: the red ✕", exists(hasTestTag("landings-row:mark:fail"), unmerged = true))
        verify("no landing is a row of the page", !exists(hasTestTag("landing-row:$landingAwait")) && !exists(hasTestTag("landing-row:$landingOld")))
        verify("no landing is a member of the project's conversations", !exists(hasText("Land · stopped") and hasAnyAncestor(hasTestTag("project-row:$launch"))))
        capture("01-landings-row")
        compose.onNodeWithTag("landings-row").performClick()
        await("the window, the waiting landing under Now") { exists(hasTestTag("landings-window")) && exists(hasTestTag("landing-entry:$landingAwait")) }
        val window = compose.onNodeWithTag("landings-window-list")
        window.performScrollToNode(hasTestTag("landing-row:$landingCancelled"))
        verify("the cancelled one is kept, and says so", says("landing-row:$landingCancelled", "Cancelled", substring = true))
        window.performScrollToNode(hasTestTag("landing-row:$landingOld"))
        verify("each settled landing once", count(hasTestTag("landing-row:$landingOld")) == 1 && count(hasTestTag("landing-row:$landingCancelled")) == 1)
        capture("02-landings-window")
        compose.onNodeWithTag("landing-row:$landingOld").performClick()
        await("the row opens in place to its record") { calls.any { it == "GET sessions/$landingOld" } && exists(hasTestTag("landing:open-arrow"), unmerged = true) }
        verify("read once", calls.count { it == "GET sessions/$landingOld" } == 1)
        capture("03-landing-opened-in-place")
    }

    /** A11-22: the project page's card for a lone merge job says nothing under its head — no “Nothing to do”. */
    @Test fun aLoneMergeJobsLandingCardOmitsNothingToDo() = journey {
        integration = """{"line":"PROJECT_BRANCH","ref":"project/launch","integratingCount":1,"queuedCount":0,
            "inFlight":{"taskTitle":null,"state":"RUNNING","startedAt":"${Instant.now().minusSeconds(66)}","kind":"CHECK_PROMOTION","jobId":"j-m","phase":"CHECK","heartbeatAt":"${ago(0)}"},
            "inFlightJobs":[{"jobId":"j-m","kind":"CHECK_PROMOTION","state":"RUNNING","phase":"CHECK","taskId":null,"taskTitle":null,"generation":1,
            "startedAt":"${Instant.now().minusSeconds(66)}","queuedAt":"${Instant.now().minusSeconds(100)}","heartbeatAt":"${ago(0)}","runnerName":null,
            "timedOut":false,"limitSeconds":600,"retryable":false,"landingSessionId":"$mergeLanding"}]}"""
        signIn()
        open("orbit-project:$launch")
        await("the project page") { exists(hasTestTag("project-detail") and hasScrollAction()) }
        scrollProject(hasTestTag("landing-card"))
        awaitTag("landing-head:title")
        verify("the card is the merge check's", textOf("landing-head:title") == "Merge check")
        verify("nothing is written under its head", !exists(hasTestTag("landing-card:what"), unmerged = true) &&
            !exists(hasText("Nothing to do — it lands on its own."), unmerged = true))
        verify("its landing is one press away", exists(hasTestTag("landing-card:open-landing"), unmerged = true))
        capture("01-lone-merge-job-card")
    }
}
