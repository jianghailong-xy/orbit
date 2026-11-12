package io.orbitd.android.increments

import androidx.compose.ui.test.*
import androidx.test.ext.junit.runners.AndroidJUnit4
import okhttp3.mockwebserver.MockResponse
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The project done card's follow-ups on a device, over the test's own fixture (docs/mocks/project-done-landing-untracked ③④ and
 * docs/mocks/project-done-followups 01–03): the CBAI shape — a project marked non-code by its coordinator whose fourth criterion is
 * held by one open task — drawn by the real project page, its done card and its sheets. Each journey leaves the screenshots set
 * beside the board's frames: the non-code done card with what stands in the way and Move to a follow-up… (③), the move's two steps
 * and the card after it (02), work that ran without a branch (④), Delivers on How it runs and its confirms (01), and the criteria met
 * by confirmation, their menu, the Confirm sheet and the done card that counts them (03).
 */
@RunWith(AndroidJUnit4::class)
class ProjectDoneFollowUpsDeviceTest : IncrementDeviceTest() {
    private val cbai = "34DoneFupProjectCbai01"
    private val launch = "34DoneFupProjectLaunch"
    private val vendor = "34DoneFupProjectVendor"
    private val coord = "34DoneFupSessionCoord1"
    private val task4 = "34DoneFupTaskSettle001"
    override val ids get() = listOf(workspace, runner, cbai, launch, vendor, coord, task4)

    private enum class Scene { NON_CODE, MOVED, BRANCHLESS, CODE, CONFIRM }
    @Volatile private var scene = Scene.NON_CODE
    private val title = "CBAI visual content platform Phase 0"

    private fun criterion(id: String, ordinal: Int, text: String, extra: String = "", revision: Int = 1, method: String = "") =
        """{"id":"$id","key":"k$ordinal","ordinal":$ordinal,"text":"$text","verificationMethod":"$method","revision":$revision$extra}"""
    private fun derived(id: String, satisfied: Boolean, reason: String?, extra: String = "") =
        """{"definitionId":"$id","satisfied":$satisfied,"landing":"UNKNOWN","landingReason":${reason?.let { "\"$it\"" } ?: "null"},"satisfiedBy":"TASKS"$extra}"""

    private val confirmedAt = "2026-11-10T10:42:00Z"
    private fun view(kind: String, note: String?, session: String? = null, revision: Int = 1, at: String = confirmedAt, shots: String = "[]") =
        """{"id":"v-$kind-$revision","revision":$revision,"confirmerKind":"$kind","outcome":"CONFIRMED","sessionId":${session?.let { "\"$it\"" } ?: "null"},
        "checkTaskId":null,"note":${note?.let { quote(it) } ?: "null"},"attachmentIds":$shots,"at":"$at",
        "criterionText":"The privacy policy is published at /privacy.","criterionVerificationMethod":"Open the page."}"""
    private fun standing(state: String, current: String?, running: String? = null) =
        """"satisfiedBy":"CONFIRMATION","confirmation":{"state":"$state","current":${current ?: "null"},"stale":${state == "STALE"},"checkRunning":${running ?: "null"}}"""

    /** Board 03's eight criteria: two met by their tasks, six by confirmation in every state the row can be in. */
    private val confirmations = listOf(
        Triple(3, "SMS provider is live.", standing("CONFIRMED", view("OWNER", "Aliyun SMS template SMS_4821 shows Approved."))),
        Triple(4, "WeChat Open Platform app is approved.", standing("CONFIRMED", view("COORDINATOR", "AppID wx3f… shows Approved on open.weixin.qq.com.", coord))),
        Triple(5, "Payment merchant account is active.", standing("CONFIRMED", view("AGENT_CHECK", "merchant 1650…22 is Active on the payment console.", coord))),
        Triple(6, "ICP filing is approved for cbai.example.cn.", standing("CHECK_FAILED", view("AGENT_CHECK", "no filing number for cbai.example.cn on beian.miit.gov.cn.", coord))),
        Triple(7, "The production domain resolves to the ingress.", standing("UNCONFIRMED", null, view("AGENT_CHECK", null, coord, at = ago(2)))),
        Triple(8, "The privacy policy is published at /privacy and names the SMS vendor.", standing("STALE", view("OWNER", null))))

    private fun document(): String {
        val nonCode = scene in setOf(Scene.NON_CODE, Scene.MOVED, Scene.CONFIRM)
        val mark = if (nonCode) """"nonCode":true,"nonCodeSetBy":"COORDINATOR","nonCodeSetAt":"2026-11-11T10:20:00Z",
            "nonCodeReason":"All work is documents and vendor accounts; no repository.",""" else """"nonCode":false,"""
        val reason = if (nonCode) null else "NO_BRANCH"
        val (items, criteria, counts, movedOut) = when (scene) {
            Scene.NON_CODE, Scene.CODE -> listOf(
                listOf(criterion("d1", 1, "Criterion 1 (placeholder text)"), criterion("d2", 2, "Criterion 2 (91 tasks)"), criterion("d3", 3, "Criterion 3 (2 tasks)"),
                    criterion("d4", 4, "External prerequisites settled: SMS provider, WeChat Open Platform app, payment merchant, ICP filing.")),
                listOf(derived("d1", true, reason), derived("d2", true, reason), derived("d3", true, reason), derived("d4", false, null)),
                """{"criteria":4,"met":3,"landed":0,"onMain":0,"byReason":{"NO_BRANCH":${if (nonCode) 0 else 3}}}""", "[]")
            Scene.MOVED -> listOf(
                listOf(criterion("d1", 1, "Criterion 1 (placeholder text)"), criterion("d2", 2, "Criterion 2 (91 tasks)"), criterion("d3", 3, "Criterion 3 (2 tasks)")),
                listOf(derived("d1", true, null), derived("d2", true, null), derived("d3", true, null)),
                """{"criteria":3,"met":3,"landed":0,"onMain":0,"byReason":{}}""",
                """[{"criterionKey":"k4","definitionId":"d4","ordinal":4,"text":"External prerequisites settled","toProjectId":"$launch",
                "toProjectTitle":"$title · follow-up","movedAt":"${ago(1)}"}]""")
            Scene.BRANCHLESS -> listOf(
                listOf(criterion("d1", 1, "Criterion 1"), criterion("d2", 2, "Criterion 2"), criterion("d3", 3, "Criterion 3")),
                listOf(derived("d1", true, null), derived("d2", true, null), derived("d3", true, "NO_BRANCH")),
                """{"criteria":3,"met":3,"landed":2,"onMain":2,"byReason":{"NO_BRANCH":1}}""", "[]")
            Scene.CONFIRM -> listOf(
                listOf(criterion("d1", 1, "Phase 0 design documents are written and reviewed."), criterion("d2", 2, "The content pipeline runs end to end on staging.")) +
                    confirmations.map { (n, text, s) -> if (n == 8) criterion("d$n", n, text, ",$s", 2, "Open the page and read the vendor list.")
                        else criterion("d$n", n, text, ",$s", method = "Read it where it is published.") },
                listOf(derived("d1", true, null), derived("d2", true, null)) +
                    confirmations.map { (n, _, s) -> derived("d$n", n in 3..5, null).replace(""""satisfiedBy":"TASKS"""", s) },
                """{"criteria":8,"met":5,"landed":0,"onMain":0,"byReason":{}}""", "[]")
        }
        // The criteria card reads each criterion's answer off its item: met or not, and what holds an unmet one.
        val answered = (items as List<*>).mapIndexed { index, item ->
            val satisfied = (criteria as List<*>)[index].toString().contains("\"satisfied\":true")
            val unmet = if (satisfied || item.toString().contains("CONFIRMATION")) "[]" else
                """[{"clause":"SERVING_WORK_UNSETTLED","heldUpBy":[{"taskId":"$task4","title":"Settle external prerequisites (SMS, WeChat, payment, ICP)","status":"OPEN",
                "requiredAction":"SUBMIT_EVIDENCE_AND_AWAIT_INDEPENDENT_DECISION"}]}]"""
            item.toString().dropLast(1) + ""","satisfied":$satisfied,"landing":"UNKNOWN","unmet":$unmet}"""
        }
        return """{"id":"$cbai","title":"$title","status":"OPEN","goal":"Phase 0 of the platform.","createdAt":"2026-11-01T00:00:00Z",
            "_count":{"tasks":155},"startedAt":"2026-11-02T00:00:00Z","coordinatorSessionId":"$coord","coordinatorEnabled":true,"configRevision":"3",
            "maxConcurrentTasks":3,"exceptionEscalationSeconds":7200,"pausedAt":null,"updatedAt":"${scene.name}",$mark
            "integration":{"line":"PROJECT_BRANCH","ref":"project/2zwQZ","upstreamRef":"main","escalationSeconds":7200},
            "acceptanceCriteriaItems":${answered.joinToString(",", "[", "]")},"criteriaMovedOut":$movedOut,
            "derivedDone":{"nonCode":$nonCode,"done":false,"criteria":${(criteria as List<*>).joinToString(",", "[", "]")},"counts":$counts}}"""
    }

    private fun doneCheck() = when (scene) {
        Scene.NON_CODE, Scene.CODE -> """{"findings":[{"severity":"REFUSE","code":"DONE_CRITERION_UNSATISFIED","message":"m","requiredAction":"r",
            "criterion":{"key":"k4","ordinal":4,"text":"External prerequisites settled: SMS provider, WeChat Open Platform app, payment merchant, ICP filing."},
            "reason":null,"tasks":[{"taskId":"$task4","title":"Settle external prerequisites (SMS, WeChat, payment, ICP)"}],"items":[],"jobs":[]}]}"""
        Scene.MOVED -> """{"findings":[]}"""
        Scene.BRANCHLESS -> """{"findings":[{"severity":"WARN","code":"DONE_CRITERION_UNLANDED","message":"m","requiredAction":"r",
            "criterion":{"key":"k3","ordinal":3,"text":"Criterion 3"},"reason":"NO_BRANCH",
            "tasks":${(1..6).joinToString(",", "[", "]") { """{"taskId":"t$it","title":"Task $it"}""" }},"items":[],"jobs":[]}]}"""
        Scene.CONFIRM -> (listOf(6, 7, 8).joinToString(",", """{"findings":[""", "]}") { n ->
            """{"severity":"REFUSE","code":"DONE_CRITERION_UNSATISFIED","message":"m","requiredAction":"r","criterion":{"key":"k$n","ordinal":$n,
            "text":${quote(confirmations.first { it.first == n }.second)}},"reason":null,"tasks":[],"items":[],"jobs":[]}""" })
    }

    private val integration = """{"line":"PROJECT_BRANCH","ref":"project/2zwQZ","upstreamRef":"main","locked":true,"integratingCount":0,"queuedCount":0,
        "inFlight":null,"mergeCheckCommand":null,"escalationSeconds":7200,"deliveryMode":"PLATFORM","repository":"jianghailong-xy/cbai"}"""
    private val projects = """[{"id":"$cbai","title":"$title","status":"OPEN","_count":{"tasks":155}},
        {"id":"$launch","title":"CBAI Phase 1 · launch readiness","status":"OPEN","_count":{"tasks":12}},
        {"id":"$vendor","title":"CBAI vendor accounts","status":"OPEN","_count":{"tasks":0}}]"""

    override fun answer(req: Req): MockResponse? {
        val p = req.parts
        return when {
            req.path == "projects" || req.path == "projects/sidebar" -> json(projects)
            p.size >= 2 && p[0] == "projects" && p[1] == cbai -> when (val rest = p.drop(2).joinToString("/")) {
                "" -> if (req.method == "GET") json(document()) else {
                    // The owner's mark, written at the press.
                    if (req.body.contains("\"nonCode\":false")) scene = Scene.CODE else if (req.body.contains("\"nonCode\":true")) scene = Scene.NON_CODE
                    json(document())
                }
                "integration" -> json(integration)
                "open-items" -> json("""{"needsYou":[],"withCoordinator":[]}""")
                "coordinator/status" -> json("""{"projectId":"$cbai","state":"LIVE","coordination":null}""")
                "done-check" -> json(doneCheck())
                "acceptance/confirmation" -> json("""{"state":"CONFIRMED","confirmed":true,"confirmation":{"confirmedAt":"2026-11-02T00:00:00Z"},
                    "currentVersion":{"digest":"seal-cbai","material":[]}}""")
                "criteria/k4/move" -> { scene = Scene.MOVED
                    json("""{"fromProjectId":"$cbai","toProjectId":"$launch","createdProject":true,"criterionKey":"k4","movedTaskIds":["$task4"],"keptTaskIds":[]}""") }
                "dependency-graph" -> json("""{"marks":[],"edges":[],"taskCount":0,"folded":false,"truncated":false}""")
                "panorama" -> json("""{"buckets":{"running":0,"ready":0,"blocked":0,"done":154,"integrating":0,"onIntegrationLine":0,"onUpstream":0,
                    "doneNotIntegrated":0,"awaitingVerification":0,"failed":0,"cancelled":0},"shape":{"taskCount":155,"edgeCount":0}}""")
                "tasks/page" -> json("""{"items":[],"nextCursor":null}""")
                "promotions/merged", "handoffs" -> json("[]")
                "promotions/current" -> empty200()
                else -> if (rest.startsWith("criteria/") && req.method == "POST") json("{}") else json("{}")
            }
            else -> null
        }
    }

    private fun openProject() {
        signIn()
        open("orbit-project:$cbai")
        await("the project page") { exists(hasTestTag("project-detail") and hasScrollAction()) && exists(hasTestTag("project-status"), unmerged = true) }
    }
    private fun scrollPage(matcher: SemanticsMatcher) {
        compose.onNode(hasTestTag("project-detail") and hasScrollAction()).performScrollToNode(matcher)
        settle()
    }
    private fun openDoneCard() {
        compose.onNodeWithTag("project-menu").performClick()
        settle()
        compose.onNodeWithText("Record as done").performClick()
        awaitTag("project-done-sheet")
        await("the done check's answer on the card") { exists(hasTestTag("project-done-keeps"), unmerged = true) || scene == Scene.MOVED }
    }
    /** Presses [tag], scrolled into view first where something scrolls it (a dialog's buttons have no scrolling parent). */
    private fun press(tag: String) {
        val node = compose.onNodeWithTag(tag, useUnmergedTree = true)
        runCatching { node.performScrollTo() }
        node.performClick(); settle()
    }

    /** Board ③ and board 02: the non-code card names what stands in the way, and Move to a follow-up… takes it to a new project. */
    @Test fun aNonCodeProjectsDoneCardAndItsMove() = journey {
        openProject()
        verify("the header carries the mark", exists(hasTestTag("project-non-code"), unmerged = true))
        verify("and says what it means where the branch would be",
            textOf("project-non-code-line") == "Non-code project · Orbit checks the criteria only, not where work landed")
        capture("01-project-header-non-code")
        openDoneCard()
        verify("the banner says who marked it", says("project-done-non-code", "Marked by the coordinator · Nov 11", substring = true))
        verify("and quotes the reason", textOf("project-done-non-code-reason") == "“All work is documents and vendor accounts; no repository.”")
        verify("the tally reads no landing", textOf("project-done-tally") == "3 of 4 met")
        verify("the rows read met and not met only", textOf("project-done-row:1-state") == "met" && textOf("project-done-row:4-state") == "not met")
        verify("one thing stands in the way", says("project-done-blockers", "1 thing stands in the way"))
        verify("criterion 4 names its open task", says("project-done-blockers", "Criterion 4 is not met — 1 task is still open"))
        verify("no landing line anywhere on the card", !exists(hasText("not on main", substring = true) and hasAnyAncestor(hasTestTag("project-done-sheet")), unmerged = true))
        capture("02-done-card-non-code")
        compose.onNodeWithTag("project-done-record", useUnmergedTree = true).performScrollTo(); settle()
        verify("Record as done anyway keeps criterion 4", textOf("project-done-keeps") == "If you record it done anyway, Orbit keeps criterion 4 as the gap you accepted.")
        capture("03-done-card-non-code-foot")
        press("project-done-move:4")
        awaitTag("move-criterion")
        verify("the new project is offered by default", says("move-criterion", "$title · follow-up"))
        capture("04-move-new-project")
        press("move-existing")
        await("the open projects to choose from") { exists(hasTestTag("move-project:$launch"), unmerged = true) }
        verify("its own project is not offered", !exists(hasTestTag("move-project:$cbai"), unmerged = true))
        press("move-project:$launch")
        capture("05-move-existing-project")
        press("move-new")
        press("move-criterion-trailing")
        awaitTag("move-confirm-title")
        verify("the second step names the destination", textOf("move-confirm-title") == "Move criterion 4 to “$title · follow-up”?")
        capture("06-move-confirm")
        press("move-confirm")
        await("the move was sent") { bodies.any { it.first == "POST projects/$cbai/criteria/k4/move" } }
        verify("it creates the follow-up", bodies.first { it.first.endsWith("/move") }.second.contains("\"newProject\":{\"title\":\"$title · follow-up\""))
        await("the card after the move") { exists(hasTestTag("project-done-moved-out"), unmerged = true) }
        await("Record as done, not anyway") { exists(hasTestTag("project-done-record") and hasText("Record as done"), unmerged = true) }
        verify("the source keeps three criteria, all met", textOf("project-done-tally") == "3 of 3 met")
        capture("07-done-card-after-move")
    }

    /** Board ④: work that ran without a branch is its own yellow reason, never "No code to land" or "not on main". */
    @Test fun branchlessWorkOnTheDoneCard() = journey {
        scene = Scene.BRANCHLESS
        openProject()
        openDoneCard()
        verify("the row says it ran without a branch", textOf("project-done-row:3-state") == "met · Ran without a branch")
        verify("the tally counts it", textOf("project-done-tally") == "3 met · 2 landed on main · 1 ran without a branch")
        verify("Orbit can't prove 1 thing", says("project-done-findings", "Orbit can’t prove 1 thing"))
        verify("the finding reads its reason", says("project-done-findings",
            "Criterion 3: 6 tasks ran without a branch, so Orbit can’t see whether their changes reached main. Check main yourself before recording it done."))
        verify("never no code to land", !exists(hasText("No code to land", substring = true), unmerged = true))
        capture("01-done-card-branchless")
    }

    /** Board 01: Delivers first on How it runs, who set the mark and why, the landing settings folded, and a confirm at each press. */
    @Test fun deliversOnHowItRuns() = journey {
        openProject()
        scrollPage(hasTestTag("project-delivers"))
        verify("Not code is chosen", says("project-delivers", "Not code"))
        verify("with who set it and when", says("project-delivers-by", "Marked by the coordinator · Nov 11, ", substring = true))
        compose.onNode(hasTestTag("project-detail") and hasScrollAction()).performScrollToNode(hasTestTag("project-landing-off")); settle()
        verify("the landing settings fold into Landing · Off", says("project-landing-off", "Off"))
        verify("Tasks land on is not drawn", !exists(hasTestTag("project-line-locked"), unmerged = true))
        capture("01-delivers-not-code")
        press("project-delivers:CODE")
        awaitTag("project-delivers-confirm")
        verify("the confirm asks to treat it as code", says("project-delivers-confirm", "Treat this project as code?"))
        capture("02-to-code-confirm")
        press("project-delivers-confirm:yes")
        await("the mark was written") { bodies.any { it.first == "PATCH projects/$cbai" && it.second.contains("\"nonCode\":false") } }
        await("the landing settings come back") { !exists(hasTestTag("project-landing-off"), unmerged = true) }
        scrollPage(hasTestTag("project-delivers"))
        capture("03-delivers-code")
        press("project-delivers:NOT_CODE")
        awaitTag("project-delivers-confirm")
        verify("the confirm asks to mark it not code", says("project-delivers-confirm", "Mark as not code?"))
        capture("04-to-not-code-confirm")
        press("project-delivers-confirm:cancel")
    }

    /** Board 03: each confirmer's row, the Met by menu, the Confirm sheet, What changed, and the done card that counts them. */
    @Test fun criteriaMetByConfirmation() = journey {
        scene = Scene.CONFIRM
        openProject()
        scrollPage(hasTestTag("criteria-standing"))
        verify("the standing line counts both ways",
            textOf("criteria-standing") == "8 criteria stated. 2 met by their tasks; 6 by a confirmation — from you, the coordinator, or an Agent check.")
        compose.onNode(hasTestTag("project-detail") and hasScrollAction()).performScrollToNode(hasText("View all 8 criteria")); settle()
        compose.onNodeWithText("View all 8 criteria").performClick(); settle()
        scrollPage(hasTestTag("criterion:3"))
        verify("the owner's confirmation", textOf("criterion-confirmation:3-state").startsWith("Met · confirmed by you · Nov 10, "))
        verify("the coordinator's", textOf("criterion-confirmation:4-state").startsWith("Met · confirmed by the coordinator"))
        capture("01-confirmed-rows")
        scrollPage(hasTestTag("criterion:6"))
        verify("an Agent check PASS", textOf("criterion-confirmation:5-state").startsWith("Met · Agent check passed"))
        verify("an Agent check FAIL", textOf("criterion-confirmation:6-state").startsWith("Not met · Agent check failed"))
        verify("a check running", textOf("criterion-confirmation:7-state").startsWith("Checking… · Agent check running · started "))
        capture("02-check-rows")
        scrollPage(hasTestTag("criterion:8"))
        verify("a stale confirmation", textOf("criterion-confirmation:8-state") == "Not met · confirmed for an earlier wording · Nov 10, 10:42" ||
            textOf("criterion-confirmation:8-state").startsWith("Not met · confirmed for an earlier wording"))
        press("criterion-confirmation:8-what-changed")
        awaitTag("criterion-confirmation:8-changes")
        capture("03-stale-what-changed")
        press("criterion-mode:4")
        awaitTag("criterion-mode:4-menu")
        capture("04-met-by-menu")
        press("criterion-mode:4-CONFIRMATION")
        press("criterion-confirmation:6-confirm")
        awaitTag("confirm-criterion")
        compose.onNodeWithTag("confirm-note").performTextInput("Filing no. 2026-0042 shows on the MIIT site")
        dropFocus()
        capture("05-confirm-sheet")
        press("confirm-press")
        await("the confirmation was sent") { bodies.any { it.first == "POST projects/$cbai/criteria/d6/confirmations" } }
        verify("with the note and the revision read",
            bodies.first { it.first.endsWith("/confirmations") }.second == """{"note":"Filing no. 2026-0042 shows on the MIIT site","revision":1}""")
        compose.onNode(hasTestTag("project-detail") and hasScrollAction()).performScrollToIndex(0); settle()
        openDoneCard()
        verify("the tally counts what waits for a confirmation", textOf("project-done-tally") == "5 of 8 met · 3 wait for confirmation")
        verify("a row says who confirmed it", textOf("project-done-row:4-state") == "met · by the coordinator")
        verify("and an Agent check's PASS", textOf("project-done-row:5-state") == "met · Agent check PASS")
        capture("06-done-card-confirmations")
        compose.onNodeWithTag("project-done-blockers", useUnmergedTree = true).performScrollTo(); settle()
        verify("criterion 6 waits for a confirmation", says("project-done-blockers", "Criterion 6 is not met — it waits for confirmation"))
        capture("07-done-card-confirmations-foot")
    }
}
