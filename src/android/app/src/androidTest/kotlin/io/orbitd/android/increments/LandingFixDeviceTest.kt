package io.orbitd.android.increments

import androidx.compose.ui.test.*
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.orbitd.android.core.cards.LandingFixCopy
import io.orbitd.android.reader.LandingFixWindowCopy
import okhttp3.mockwebserver.MockResponse
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Contract revision 42 part one on a device, as the owner ruled it on the board (docs/mocks/landing-fix-own-session, ruled 2026-11-22;
 * Android follows the iPhone frames ② a–d and the project page's ④ d, e), over the test's own controlled HTTP fixture — not a deployment.
 * One project on a project branch, two tasks whose landings conflicted: A10c's went to its own session, which fixes it and lands again;
 * A11k's session ended its turn without a commit and handed it back to the coordinator. Every frame leaves a screenshot.
 */
@RunWith(AndroidJUnit4::class)
class LandingFixDeviceTest : IncrementDeviceTest() {
    private val project = "35LandFixProject000001"
    private val coord = "35LandFixCoordinator01"
    private val work1 = "35LandFixWorkSession01"; private val work2 = "35LandFixWorkSession02"
    private val land1 = "35LandFixLanding000001"; private val land2 = "35LandFixLanding000002"
    private val task1 = "35LandFixTask000000001"; private val task2 = "35LandFixTask000000002"
    override val ids get() = listOf(workspace, runner, project, coord, work1, work2, land1, land2, task1, task2)
    private val theme = InstrumentationRegistry.getArguments().getString("landing_fix_theme") ?: "light"
    private val branch = "project/34ZZnCsCFp"
    private val title1 = "A10c · Notification cold start drops the session"
    private val title2 = "A11k · Write back before enabling the button"
    private val words2 = "The conflict is with A13f's store refactor, which removes the list-ready signal my fix waits on. " +
        "Which of the two designs stays is not mine to decide."
    /** What A11k's session said after its hand-back: the session row's own last words now, which the quote must not take. */
    private val later2 = "Waiting for the coordinator's call on the store refactor."

    /** A10c's session has committed its fix, and the landing is queued again (board ② b ③, ② c ②). */
    @Volatile private var fixed = false

    private val handedAt = ago(4); private val fixedAt = ago(1); private val returnedAt = ago(0)
    private val turn = listOf(
        "Orbit could not land your work for \"$title1\" on $branch.", "",
        "Conflict while rebasing onto $branch at 41ac9e0:",
        "app/src/main/kotlin/io/orbitd/notify/ColdStartRouter.kt, app/src/main/kotlin/io/orbitd/session/SessionListStore.kt", "",
        "Nothing was pushed. $branch is unchanged.", "",
        "Fix it on your own branch, in this checkout:",
        "1. Merge $branch into your branch and resolve what conflicts.",
        "2. Run what failed until it passes.",
        "3. Commit, then end your turn.", "",
        "Orbit lands the new commit and runs the checks again by itself. Do not push $branch.",
        "If this is not yours to fix, end your turn without committing and say why; the project's coordinator takes it from there.",
        "The full record: landing $land1.",
    ).joinToString("\n")
    private val reply = "Merged `$branch` into my branch. Both conflicts were with A13f's store refactor: I kept its `SessionListStore` API " +
        "and moved my wait-for-list onto it. `ColdStartRouteTest` passes. Committed `4be19c2`."

    // MARK: rows

    private fun member(role: String) = """"projectId":"$project","projectMembership":{"projectId":"$project","projectTitle":"Wiki server execution",
        "projectStatus":"OPEN","role":"$role"}"""
    private fun row(id: String, title: String, run: String, extra: String) = """{"id":"$id","title":"$title","status":"$run","runState":"$run",
        "lifecycleState":"OPEN","agent":{"id":"$workspace","name":"Alpha"},"agentId":"$workspace","createdAt":"${ago(90)}","lastTurnAt":"${ago(1)}",
        "pendingApprovals":0,"tags":[],"provider":"claude","engine":"claude","model":"claude-opus-5-5","assignedRunnerId":"$runner",
        "capabilities":{"canSend":true,"canResume":false,"canComplete":true}$extra}"""
    private fun coordRow() = row(coord, "Wiki server execution", "AWAITING_INPUT", ""","lastAssistantText":"Watching 1 of 12 tasks.",${member("COORDINATOR")}""")
    private fun work1Row() = row(work1, "Run task: $title1", if (fixed) "AWAITING_INPUT" else "RUNNING", ""","lastAssistantText":${quote(reply)},${member("TASK")}""")
    private fun work2Row() = row(work2, "Run task: $title2", "AWAITING_INPUT", ""","lastAssistantText":${quote(later2)},${member("TASK")}""")
    private fun landingRow(id: String, title: String, state: String) = """{"id":"$id","title":"Land · $title","status":"AWAITING_INPUT",
        "createdAt":"${ago(18)}","lastTurnAt":"${ago(1)}","sessionKind":"LANDING","landing":{"subject":"TASK","state":"$state","settledAs":null,
        "settledAt":null},"projectMembership":{"projectId":"$project","projectTitle":"Wiki server execution","projectStatus":"OPEN","role":"LANDING"}}"""

    override fun sessions(view: String, project: String?): String = if (view != "open") "[]" else (listOf(coordRow(), work1Row(), work2Row()) +
        if (project != null) listOf(landingRow(land1, title1, if (fixed) "IN_FLIGHT" else "FIXING"), landingRow(land2, title2, "AWAITING_DECISION"))
        else emptyList()).joinToString(",", "[", "]")

    // MARK: the landings

    private fun entry(kind: String, at: String, text: String, claim: Int = 1, extra: String = "") =
        """{"kind":"$kind","at":"$at","claim":$claim,"round":1,"text":${quote(text)}$extra}"""
    private fun generation1(task: String, work: String, back: Boolean) = listOfNotNull(
        entry("ENQUEUED", ago(18), "Task marked done · queued to land on $branch", 0),
        entry("CLAIMED", ago(17), "Claimed by runner workstation-gpu · claim 1"),
        entry("STEP", ago(17), "Rebasing onto $branch", extra = ""","phase":"REBASE""""),
        entry("RESULT", ago(16), "Conflict in 2 files · nothing was pushed", extra = ""","data":{"state":"CONFLICT"}"""),
        entry("HANDED_TO_SESSION", if (back) ago(10) else handedAt, "Handed to the task's session", extra = ""","data":{"itemId":"item-$task","sessionId":"$work"}"""),
        if (back) entry("RETURNED_TO_COORDINATOR", returnedAt, "Returned to the coordinator: no new commit",
            extra = ""","reason":"NO_NEW_COMMIT","data":{"itemId":"item-$task","sessionId":"$work","returnReason":"NO_NEW_COMMIT","lastMessage":${quote(words2)}}""") else null,
    ).joinToString(",", "[", "]")
    private fun attempt(job: String, state: String, generation: Int, phase: String?) = """{"jobId":"$job","kind":"LAND_TASK","state":"$state",
        "generation":$generation,"phase":${phase?.let { "\"$it\"" } ?: "null"},"round":1,"step":null,"claim":${if (state == "QUEUED") 0 else 1},
        "runnerName":"workstation-gpu","sourceSessionId":"$work1","targetRef":"refs/heads/$branch","startedAt":"${if (state == "QUEUED") fixedAt else ago(17)}",
        "heartbeatAt":"${ago(16)}","outputMovedAt":null,"progressProtocol":"v2","check":null,"liveness":null,"blockingReason":null,"timedOut":false,
        "limitSeconds":600,"retryable":false,"pushBoundaryPassed":false}"""
    private fun landingView(id: String): String {
        val one = id == land1
        val sections = mutableListOf("""{"title":"Generation 1","jobId":"$id-j1","kind":"LAND_TASK","generation":1,"state":"CONFLICT",
            "entries":${generation1(if (one) task1 else task2, if (one) work1 else work2, back = !one)}}""")
        if (one && fixed) sections += """{"title":"Generation 2","jobId":"$id-j2","kind":"LAND_TASK","generation":2,"state":"QUEUED","entries":[
            ${entry("FIXED_BY_SESSION", fixedAt, "Fixed in 4be19c2 · landing again", 0,
                ""","reason":"Fixed by the task's own session","data":{"retryOfJobId":"$id-j1","failureClass":"CONFLICT","sessionId":"$work1","sourceSha":"4be19c2a7d0e"}""")},
            ${entry("ENQUEUED", fixedAt, "Queued again to land on $branch", 0)}]}"""
        val current = if (one && fixed) attempt("$id-j2", "QUEUED", 2, null) else attempt("$id-j1", "CONFLICT", 1, "REBASE")
        return """{"sessionId":"$id","projectId":"$project","subject":"TASK","taskId":"${if (one) task1 else task2}","promotionId":null,"episode":1,
            "openedAt":"${ago(18)}","settledAt":null,"settledAs":null,"checks":[],"currentAttempt":$current,"todos":[],"generations":[],
            "timeline":{"sections":${sections.joinToString(",", "[", "]")},"facts":[],"truncated":false}}"""
    }
    private fun landingDetail(id: String) = """{"id":"$id","title":"Land · ${if (id == land1) title1 else title2}","status":"AWAITING_INPUT",
        "sessionKind":"LANDING","workspace":null,"assignedRunner":null,"tags":[],"landing":${landingView(id)}}"""

    // MARK: the project

    private fun item(task: String, title: String, work: String, held: Boolean) = """{"itemId":"item-$task","kind":"INTEGRATION_CONFLICT",
        "title":"Landing conflict · $title","detailLine":"","assignee":"COORDINATOR","assigneeReason":"INTEGRATION","waitingSince":"${if (held) handedAt else returnedAt}",
        "escalateAt":null,"escalatedAt":null,"taskId":"$task","sessionId":"$work","landingSessionId":"${if (task == task1) land1 else land2}",
        "integrationJobId":"${if (task == task1) land1 else land2}-j1","promotionId":null,"fuseEpisodeId":null,
        "delivery":{"state":"${if (held) "NOT_DELIVERED" else "DELIVERED"}","sessionId":null,"at":null},"actions":[],"question":null,
        "workSession":{"sessionId":"$work","offeredAt":"${if (held) handedAt else ago(10)}",${if (held) "" else """"returnedAt":"$returnedAt","returnReason":"NO_NEW_COMMIT","lastMessage":${quote(words2)},"""}"rounds":0}}"""
    private fun openItems() = """{"needsYou":[],"withCoordinator":[${item(task2, title2, work2, held = false)}],
        "withWorkSession":[${if (fixed) "" else item(task1, title1, work1, held = true)}],"startRequest":null,"doneRequest":null}"""
    private fun taskRow(id: String, title: String, status: String, integration: String?) = """{"id":"$id","title":"$title","status":"$status",
        "workState":"${if (status == "DONE") "DONE" else "RUNNING"}","dependencyState":"READY","landingWaitCount":0,"topoLevel":0,"autoRunWhenReady":true,
        "integration":${integration ?: "null"}}"""
    private fun tasks() = """{"items":[
        ${taskRow(task1, title1, "DONE", if (fixed) """{"state":"QUEUED","handler":"PLATFORM"}""" else """{"state":"FIXING","since":"$handedAt","workSessionId":"$work1"}""")},
        ${taskRow(task2, title2, "DONE", """{"state":"CONFLICT","handler":"COORDINATOR"}""")},
        ${taskRow("35LandFixTask000000003", "A13f · Order model accounts in Runner settings", "DONE", """{"state":"ON_INTEGRATION_LINE"}""")},
        ${taskRow("35LandFixTask000000004", "A08l · Collapse the input on Android 15 window recreation", "IN_PROGRESS", null)}],"nextCursor":null}"""
    private fun document() = """{"id":"$project","title":"Wiki server execution","status":"OPEN","goal":"Run the wiki on the server.",
        "createdAt":"2026-11-01T00:00:00Z","_count":{"tasks":46},"startedAt":"2026-11-02T00:00:00Z","coordinatorSessionId":"$coord",
        "coordinatorEnabled":true,"configRevision":"3","maxConcurrentTasks":3,"exceptionEscalationSeconds":7200,"pausedAt":null,
        "integration":{"line":"PROJECT_BRANCH","ref":"$branch","upstreamRef":"main","escalationSeconds":7200},"acceptanceCriteriaItems":[]}"""

    override fun answer(req: Req): MockResponse? {
        val p = req.parts
        return when {
            req.path == "projects/sidebar" || req.path == "projects" -> json("""[{"id":"$project","title":"Wiki server execution","status":"OPEN",
                "createdAt":"2026-11-01T00:00:00Z","buckets":{"running":1},"taskCounts":{"done":44,"failed":0,"total":46},"attention":{},
                "integration":{"line":"PROJECT_BRANCH","ref":"$branch","activeJobCount":1},"startedAt":"2026-11-02T00:00:00Z","mainBranch":"main"}]""")
            req.path == "sessions/$coord" && req.method == "GET" -> json(coordRow())
            req.path == "sessions/$work1" && req.method == "GET" -> json(work1Row())
            req.path == "sessions/$work2" && req.method == "GET" -> json(work2Row())
            req.path == "sessions/$work1/events/page" -> json(page(listOfNotNull(
                event(1, "user", """{"text":${quote("Run task: $title1")}}""", ago(60)),
                event(2, "assistant", """{"text":"Done: the cold start now waits for the session list before it routes."}""", ago(30)),
                event(3, "user", """{"text":${quote(turn)}}""", handedAt, "turn-landing-fix"),
                if (fixed) event(4, "assistant", """{"text":${quote(reply)}}""", fixedAt) else null)))
            p.size == 2 && p[0] == "sessions" && p[1] in listOf(land1, land2) && req.method == "GET" -> json(landingDetail(p[1]))
            p[0] == "sessions" && (p.last() == "landing" || p.last() == "log") -> json("""{"jobId":"j-1","entries":[],"nextCursor":null}""")
            p.size == 2 && p[0] == "tasks" && p[1] in listOf(task1, task2) -> json("""{"id":"${p[1]}","title":"${if (p[1] == task1) title1 else title2}",
                "status":"DONE","projectId":"$project"}""")
            p.size >= 2 && p[0] == "projects" && p[1] == project -> when (p.drop(2).joinToString("/")) {
                "" -> if (req.method == "GET") json(document()) else null
                "integration" -> json("""{"line":"PROJECT_BRANCH","ref":"$branch","upstreamRef":"main","integratingCount":0,"queuedCount":${if (fixed) 1 else 0},"inFlight":null}""")
                "open-items" -> json(openItems())
                "coordinator/status" -> json("""{"projectId":"$project","readAt":"${ago(0)}","state":"ACTIVE","coordination":{"session":{"id":"$coord","title":"Wiki server execution"}}}""")
                "promotions/current" -> empty200()
                "promotions/merged", "handoffs" -> json("[]")
                "acceptance/confirmation" -> json("""{"state":"CONFIRMED","confirmed":true,"currentVersion":{"digest":"seal","material":[]}}""")
                "dependency-graph" -> json("""{"marks":[],"edges":[],"taskCount":0,"folded":false,"truncated":false}""")
                "panorama" -> json("""{"buckets":{"running":1,"ready":0,"blocked":0,"done":44,"integrating":2,"onIntegrationLine":42,"onUpstream":0,
                    "doneNotIntegrated":0,"awaitingVerification":0,"failed":0,"cancelled":0},"shape":{"taskCount":46,"edgeCount":0}}""")
                "tasks/page" -> json(tasks())
                else -> json("{}")
            }
            else -> null
        }
    }

    @Test fun theLandingFixAsRuled() = journey {
        note("theme=$theme")
        signIn()

        // ② c — the Landings window: A10c Fixing, whose hands and which round, the hand-off line; A11k handed back with its last words.
        open("orbit-session:$land1")
        await("the window, A10c fixing") { exists(hasTestTag("landing:fixing"), unmerged = true) }
        await("the fixing line") { says("landing:fixing-line", "The task's session is fixing it · 4m · round 1 of 2") }
        verify("the head says Fixing", exists(hasTestTag("landing-head:fixing"), unmerged = true))
        verify("its clause says who is on it", says("landing-head:detail", "conflict · ${LandingFixWindowCopy.ITS_OWN_SESSION_IS_ON_IT}"))
        verify("the hand-off line", exists(hasTestTag("landing:fix-line:handed_to_session"), unmerged = true))
        verify("the session's door first", exists(hasTestTag("landing:fixing:open_work_session"), unmerged = true))
        // ② c ③: while a landing is with its task's session, the footer says the whole ruled sentence, visibly.
        await("the ruled footer") { textOf("landings:footer-line") ==
            "Orbit runs these landings — nothing to type here. ${LandingFixWindowCopy.DECISIONS_SESSION_FIRST}" }
        val window = compose.onNodeWithTag("landings-window-list")
        window.performScrollToNode(hasTestTag("landing-entry:$land1"))
        capture("$theme-c-window-fixing")

        // ② d — handed back: the session's last words, the coordinator has it, the three doors, the Returned line.
        window.performScrollToNode(hasTestTag("landing:fix-line:returned_to_coordinator"))
        await("the hand-back quote") { exists(hasTestTag("landing:hand-back-words"), unmerged = true) }
        verify("the lead says why", says("landing:hand-back-lead", LandingFixWindowCopy.handBackLead("NO_NEW_COMMIT")))
        verify("the words are the ones the server froze at the hand-back", says("landing:hand-back-words", "“$words2”"))
        verify("not what the session said since", !exists(hasText(later2, substring = true), unmerged = true))
        verify("no read of the work session for its words", calls.none { it == "GET sessions/$work2" })
        verify("the returned line", says("landing:fix-line:returned_to_coordinator", "Returned to the coordinator · no new commit", substring = true))
        verify("Open session among the coordinator's doors", exists(hasTestTag("landing:wait:open_work_session"), unmerged = true))
        // ② d: what failed is said once — the head's clause, then the generation's own sentence, never the clause twice.
        val handedBack = hasAnyAncestor(hasTestTag("landing-entry:$land2"))
        verify("the clause once", count(hasText("Could not merge · conflict") and handedBack, unmerged = true) == 1)
        verify("the failure in its own words", exists(hasTestTag("landing:failure") and hasText("Conflict in 2 files · nothing was pushed") and handedBack, unmerged = true))
        window.performScrollToNode(hasTestTag("landing:hand-back"))
        capture("$theme-d-window-handed-back")

        // ④ d, e — the project page: Being fixed by its session, and the task row Landing · fixing that opens that session.
        open("orbit-project:$project")
        await("the project page") { exists(hasTestTag("project-detail") and hasScrollAction()) }
        compose.onNode(hasTestTag("project-detail") and hasScrollAction()).performScrollToNode(hasTestTag("project-task:$task1"))
        await("the task row's chip") { exists(hasText(LandingFixWindowCopy.LANDING_FIXING), unmerged = true) }
        capture("$theme-e-task-row")
        compose.onNode(hasTestTag("project-detail") and hasScrollAction()).performScrollToNode(hasTestTag("project-open-items"))
        compose.onNodeWithTag("project-open-items").performClick(); settle()
        await("Being fixed by its session") { exists(hasTestTag("open-item:item-$task1:being-fixed"), unmerged = true) }
        verify("its line", says("open-item:item-$task1:being-fixed", "The task's session is on it · 4m · round 1 of 2 · nothing was pushed"))
        verify("nobody's Needs you", !exists(hasText("NEEDS YOU")))
        verify("none waits on the owner", says("project-open-items-subtitle", LandingFixWindowCopy.noneWaitingOnYou(1)))
        capture("$theme-d-open-items")
        // ② b — the task's own session, which the row opens: the card Orbit sent it, its answer, and — the fix committed and queued
        // again — the line under them (② b ③).
        fixed = true
        compose.onNodeWithTag("open-item:item-$task1").performClick(); settle()
        await("the row opened its session") { app.realtime.state.value.session?.id?.let { io.orbitd.android.navigation.ObjectId.same(it, work1) } == true }
        await("the landing-fix card") { exists(hasTestTag("record:3:landingFix:title"), unmerged = true) }
        verify("its title", says("record:3:landingFix:title", LandingFixCopy.couldNotLand(branch)))
        verify("Conflict on its chip", says("record:3:landingFix:kind", LandingFixCopy.CONFLICT))
        verify("drawn as the card, not the reader's bubble", !exists(hasText("Orbit could not land your work for", substring = true), unmerged = true))
        scrollTranscriptTo(hasTestTag("record:3:landingFix"))
        capture("$theme-b-session-card")
        await("Landing 4be19c2 again") { exists(hasTestTag("record:3:landingFix:again"), unmerged = true) }
        scrollTranscriptTo(hasTestTag("record:3:landingFix:again"))
        capture("$theme-b-session-landing-again")

        // ② c ② — the window's Fixed line, opening the generation that lands again.
        open("orbit-session:$land1")
        await("the Fixed line") { exists(hasTestTag("landing:fix-line:fixed_by_session"), unmerged = true) }
        await("A11k's card read whole again") { exists(hasTestTag("landing:hand-back-words"), unmerged = true) }
        // Nothing is with a task's session any more: today's footer, one line.
        await("today's footer") { textOf("landings:footer-line") == "Orbit runs these landings" }
        compose.onNodeWithTag("landings-window-list").performScrollToNode(hasTestTag("landing:fix-line:fixed_by_session"))
        capture("$theme-c-window-fixed-again")
    }
}
