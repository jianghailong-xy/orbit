package io.orbitd.android.core.cards

import io.orbitd.android.core.net.ApiRequest
import io.orbitd.android.core.net.HttpMethod
import io.orbitd.android.core.protocol.Wire
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.time.Instant

/**
 * The owner's exception card (A08-17; OrbitKit `ExceptionCards`, `ExceptionCardsTests`): which door each RETRY goes through, what
 * the card opens with, the doors in their weights with the line each wears, the Review gate, the facts, and the owner's own ending.
 * The routes are held to the server's door table (`open-item-doors.ts`) and the words to OrbitKit's source; a missing counterpart is
 * a failure, never a skip.
 */
class ExceptionCardsTest {
    private val now = Instant.parse("2026-09-21T12:00:00Z")

    private fun row(kind: String = "TASK_FAILED", assignee: String = "OWNER", reason: String = "ESCALATED",
        taskId: String? = "01a03f58-40bd-76ac-85c1-d9c6b29f8ca9", sessionId: String? = "489fc485-949c-533a-9b56-7712a68762ef",
        promotionId: String? = null, actions: List<String> = listOf("ASK_COORDINATOR_AGAIN", "OPEN_TASK_SESSION", "CANCEL_TASK"),
        requiredAction: String? = null, primaryAction: String? = null, handledBy: List<String>? = null,
        waitingSince: String = "2026-09-19T19:01:41.497Z", escalatedAt: String? = "2026-09-19T21:02:23.903Z",
        detailLine: String = "the run ended with exit code 1", delivery: String? = null, facts: JsonElement = JsonNull,
        fuseEpisodeId: String? = null, title: String = "Task failed: P5.1 Route Handlers",
        landingSessionId: String? = null, integrationJobId: String? = null, lease: JsonElement = JsonNull,
        coordinatorUnreachable: Boolean? = null, handledByStates: List<String>? = null) = buildJsonObject {
        put("itemId", "01a0bb0b-b3fb-744c-b9a6-2fd68b4420b4"); put("kind", kind); put("title", title); put("detailLine", detailLine)
        put("assignee", assignee); put("assigneeReason", reason); put("waitingSince", waitingSince); put("escalatedAt", escalatedAt)
        put("taskId", taskId); put("sessionId", sessionId); put("promotionId", promotionId); put("fuseEpisodeId", fuseEpisodeId)
        put("landingSessionId", landingSessionId); put("integrationJobId", integrationJobId)
        putJsonObject("delivery") { put("state", if (delivery == null) "NOT_REQUIRED" else "DELIVERED"); put("sessionId", delivery); put("at", JsonNull) }
        putJsonArray("actions") { actions.forEach { add(it) } }
        requiredAction?.let { put("requiredAction", it) }
        primaryAction?.let { put("primaryAction", it) }
        handledBy?.let { titles -> putJsonArray("handledBy") { titles.forEachIndexed { i, t -> addJsonObject { put("taskId", "t$i"); put("title", t); put("state", handledByStates?.get(i) ?: "OPEN") } } } }
        put("question", JsonNull); put("facts", facts); put("lease", lease)
        coordinatorUnreachable?.let { put("coordinatorUnreachable", it) }
    }

    /** The coordinator conversation's cards for these items, as the catalogue grants them. */
    private fun cards(vararg rows: JsonObject): List<InteractionCard> = CardCatalog.project("s1", "p1", mapOf(
        "project" to buildJsonObject { put("id", "p1") },
        "openItems" to buildJsonObject { putJsonArray("needsYou") { rows.forEach { add(it) } }; putJsonArray("withCoordinator") {} }))

    @Test fun onlyOwnerExceptionsBecomeConversationCards() {
        val owner = row()
        val coordinator = JsonObject(row(assignee = "COORDINATOR", reason = "DEFAULT", escalatedAt = null) +
            ("itemId" to JsonPrimitive("coordinator")))
        val settled = JsonObject(coordinator + mapOf(
            "itemId" to JsonPrimitive("coordinator-settled"),
            "outcome" to buildJsonObject { put("state", "RESOLVED"); put("resolution", "HANDLED") },
        ))
        val items = buildJsonObject {
            put("needsYou", JsonArray(listOf(owner)))
            put("withCoordinator", JsonArray(listOf(coordinator)))
            put("settled", JsonArray(listOf(settled)))
        }
        val cards = CardCatalog.project("s1", "p1", mapOf(
            "project" to buildJsonObject { put("id", "p1") },
            "openItems" to items,
        ))
        assertEquals(listOf("item:${owner.text("itemId")}"), cards.map { it.key })
    }

    private fun body(request: ApiRequest) = Wire.json.parseToJsonElement(request.body!!.decodeToString()).jsonObject

    private fun root() = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
        .firstOrNull { File(it, "src/apiserver/src/projects/open-item-doors.ts").isFile }
        ?: error("src/apiserver/src/projects/open-item-doors.ts was not found above the test's working directory")

    // MARK: RETRY is three doors under one name

    /** The four kinds of item, each to the door its kind names — and with the item's own sentence as the reason. Before A08-17 every
     * RETRY with a task went to `tasks/:id/execute`, which an integration item's landing is not, and a row with a candidate and no
     * task drew no Retry at all. */
    @Test fun eachRetryGoesThroughTheDoorItsItemNames() {
        // A merge candidate's failed check: the candidate's check runs again, whatever task the row also names.
        val candidate = cards(row(kind = "INTEGRATION_CHECK_FAILED", promotionId = "pr1", taskId = "t1", actions = listOf("ASK_COORDINATOR_AGAIN", "RETRY"),
            requiredAction = "  Nothing on the project branch reaches main until this check passes.  ")).single()
        assertTrue(CardVerb.RERUN_CHECK in candidate.actions)
        assertFalse(CardVerb.RETRY_TASK in candidate.actions); assertFalse(CardVerb.RETRY_INTEGRATION in candidate.actions)
        val rerun = CardRequests.build(candidate, CardVerb.RERUN_CHECK)
        assertEquals(HttpMethod.POST, rerun.method)
        assertEquals(listOf("projects", "p1", "promotions", "pr1", "integration", "retry"), rerun.path)
        assertEquals("the item's own sentence, trimmed", "Nothing on the project branch reaches main until this check passes.", body(rerun).text("reason"))

        // A failed task runs again through Run now's door, as it always did, with the press's own identity.
        val failed = cards(row(kind = "TASK_FAILED", actions = listOf("ASK_COORDINATOR_AGAIN", "OPEN_TASK_SESSION", "RETRY", "CANCEL_TASK"))).single()
        assertTrue(CardVerb.RETRY_TASK in failed.actions)
        assertFalse(CardVerb.RETRY_INTEGRATION in failed.actions); assertFalse(CardVerb.RERUN_CHECK in failed.actions)
        val again = CardRequests.build(failed, CardVerb.RETRY_TASK, CardInput(triggerId = "press-1"))
        assertEquals(listOf("tasks", "01a03f58-40bd-76ac-85c1-d9c6b29f8ca9", "execute"), again.path)
        assertEquals("press-1", body(again).text("triggerId"))

        // Any other integration item queues its task's landing again — the door the server lists for it, not execute.
        for (kind in listOf("INTEGRATION_ERROR", "INTEGRATION_CHECK_FAILED", "INTEGRATION_CONFLICT", "DELIVERY_REVIEW")) {
            val landing = cards(row(kind = kind, actions = listOf("ASK_COORDINATOR_AGAIN", "RETRY"))).single()
            assertEquals(kind, listOf(CardVerb.RETURN_COORDINATOR, CardVerb.RETRY_INTEGRATION), landing.actions.filter { it != CardVerb.MARK_HANDLED })
            val request = CardRequests.build(landing, CardVerb.RETRY_INTEGRATION)
            assertEquals(kind, listOf("projects", "p1", "tasks", "01a03f58-40bd-76ac-85c1-d9c6b29f8ca9", "integration", "retry"), request.path)
            assertEquals("a row with no sentence still carries one", ExceptionCards.retryReasonFallback, body(request).text("reason"))
        }

        // A row that names only a candidate is drawn a Retry now, through the candidate's door.
        val onlyCandidate = cards(row(kind = "INTEGRATION_ERROR", promotionId = "pr2", taskId = null, sessionId = null,
            actions = listOf("RETRY", "ASK_COORDINATOR_AGAIN"))).single()
        assertTrue(CardVerb.RERUN_CHECK in onlyCandidate.actions)
        assertEquals(listOf("projects", "p1", "promotions", "pr2", "integration", "retry"), CardRequests.build(onlyCandidate, CardVerb.RERUN_CHECK).path)
        assertEquals(listOf("RETRY", "ASK_COORDINATOR_AGAIN"), ExceptionCards.drawn(onlyCandidate.source))
        assertEquals(CardVerb.RERUN_CHECK, ExceptionCards.verb(onlyCandidate.source, "RETRY"))

        // A RETRY nothing addresses is no door at all: a failed task with no task, an item with neither id.
        assertNull(ExceptionCards.retryVerb(row(kind = "TASK_FAILED", taskId = null)))
        assertNull(ExceptionCards.retryVerb(row(kind = "INTEGRATION_ERROR", taskId = null)))
        assertTrue(cards(row(kind = "INTEGRATION_ERROR", taskId = null, sessionId = null, actions = listOf("RETRY"))).single()
            .actions.none { it in setOf(CardVerb.RETRY_TASK, CardVerb.RETRY_INTEGRATION, CardVerb.RERUN_CHECK) })
        // And a door the server did not list is not drawn into one.
        assertTrue(cards(row(kind = "INTEGRATION_ERROR", actions = listOf("ASK_COORDINATOR_AGAIN"))).single().actions.none { it == CardVerb.RETRY_INTEGRATION })
    }

    /** The routes above are the owner's own in the server's door table (`open-item-doors.ts`): the landing retry and the candidate's
     * re-check are `integration-retry-task` / `-promotion`, and a FAILED task's RETRY is `task-start` through execute. */
    @Test fun theRoutesAreTheDoorTablesOwn() {
        val table = File(root(), "src/apiserver/src/projects/open-item-doors.ts").readText()
        listOf("'integration-retry-task'", "'/projects/:id/tasks/:taskId/integration/retry'",
            "'integration-retry-promotion'", "'/projects/:id/promotions/:promotionId/integration/retry'",
            "'task-start'", "route: owner ? '/tasks/:id/execute'",
        ).forEach { assertTrue("open-item-doors.ts no longer says $it", table.contains(it)) }
        val controller = File(root(), "src/apiserver/src/projects/project-integration-retry.controller.ts").readText()
        listOf("@Post(':id/tasks/:taskId/integration/retry')", "@Post(':id/promotions/:promotionId/integration/retry')")
            .forEach { assertTrue("the owner's retry controller no longer routes $it", controller.contains(it)) }
        val dto = File(root(), "src/apiserver/src/projects/dto.ts").readText()
        assertTrue("RetryIntegrationDto takes the reason the press carries",
            Regex("class RetryIntegrationDto \\{\\s*@IsString\\(\\) @MinLength\\(1\\) @MaxLength\\(MAX_INTEGRATION_RETRY_REASON\\) reason!: string;").containsMatchIn(dto))
    }

    /** A refusal says which door refused, in the browser's headline, ahead of the server's reason. */
    @Test fun aRefusalIsSaidUnderItsDoorsHeadline() {
        assertEquals(ExceptionCards.notRerunCheck, ExceptionCards.refusalHeadline(CardVerb.RERUN_CHECK))
        assertEquals(ExceptionCards.notRetriedLanding, ExceptionCards.refusalHeadline(CardVerb.RETRY_INTEGRATION))
        assertEquals(ExceptionCards.notRunAgain, ExceptionCards.refusalHeadline(CardVerb.RETRY_TASK))
        assertEquals(ExceptionCards.notMarkedHandled, ExceptionCards.refusalHeadline(CardVerb.MARK_HANDLED))
        assertNull(ExceptionCards.refusalHeadline(CardVerb.CANCEL_TASK))
    }

    // MARK: the two landing doors (§2.9 LS6, §4.6 X-E5)

    private fun lease(jobKind: String = "LAND_TASK", protocol: String? = "v2", pushed: Boolean = false, generation: Int = 2,
        runner: String? = "workstation-gpu", phase: String = "REBASE", claim: Int = 1, round: Int = 1, checks: Int = 3,
        reportedAt: String = "2026-09-21T11:30:00Z", expiredAt: String? = "2026-09-21T11:40:00Z") = buildJsonObject {
        put("jobKind", jobKind); protocol?.let { put("progressProtocol", it) }; put("pushReported", pushed); put("generation", generation)
        runner?.let { put("runner", it) }; put("phase", phase); put("claimGeneration", claim); put("round", round); put("checkCount", checks)
        put("lastReportAt", reportedAt); expiredAt?.let { put("leaseExpiredAt", it) }
    }

    private fun xe5(actions: List<String> = listOf("ABANDON", "OPEN_LANDING"), primaryAction: String? = "ABANDON",
        lease: JsonElement = lease(), landingSessionId: String? = "L1", integrationJobId: String? = "j-1",
        waitingSince: String = "2026-09-19T19:01:41.497Z", escalatedAt: String? = "2026-09-19T21:02:23.903Z",
        facts: JsonElement = JsonNull) =
        row(kind = "LANDING_LEASE_EXPIRED", reason = "ESCALATED", actions = actions, primaryAction = primaryAction, taskId = "t1",
            sessionId = null, landingSessionId = landingSessionId, integrationJobId = integrationJobId, lease = lease,
            waitingSince = waitingSince, escalatedAt = escalatedAt, facts = facts)

    /** OPEN_LANDING opens the session the row names and sends nothing; ABANDON is the one job's, through the landing page's own door.
     * Both are drawn only where the row carries the address they need, and an action this build cannot name is still no door. */
    @Test fun theLandingDoorsAreDrawnOnlyWhereTheRowCarriesTheirAddresses() {
        val full = xe5()
        assertEquals(listOf("ABANDON", "OPEN_LANDING"), ExceptionCards.drawn(full))
        assertNull("Open landing only looks: it sends nothing", ExceptionCards.verb(full, "OPEN_LANDING"))
        assertEquals(CardVerb.ABANDON, ExceptionCards.verb(full, "ABANDON"))
        val card = cards(full).single()
        assertTrue(CardVerb.ABANDON in card.actions)
        val abandon = CardRequests.build(card, CardVerb.ABANDON)
        assertEquals(listOf("projects", "p1", "integration", "jobs", "j-1", "abandon"), abandon.path)
        assertEquals(HttpMethod.POST, abandon.method)
        assertEquals(ExceptionCards.notAbandoned, ExceptionCards.refusalHeadline(CardVerb.ABANDON))
        // A row an older build opened names no landing and no job: neither door is drawn, and neither is a press.
        val older = xe5(actions = listOf("ABANDON", "OPEN_LANDING"), landingSessionId = null, integrationJobId = null, lease = JsonNull)
        assertEquals(emptyList<String>(), ExceptionCards.drawn(older))
        assertEquals(listOf(CardVerb.MARK_HANDLED), cards(older).single().actions)
        // An action this build cannot name is never a door, beside the two it can.
        assertEquals(listOf("ABANDON", "OPEN_LANDING"), ExceptionCards.drawn(xe5(actions = listOf("SOMETHING_NEW", "ABANDON", "OPEN_LANDING"))))
    }

    /** X-E5 leads with the server's ABANDON as its solid primary, whatever order it was listed in, and every door's line follows J12. */
    @Test fun theXe5CardLeadsWithAbandonAndItsConsequenceFollowsJ12() {
        val mine = ExceptionCards.presses(xe5(primaryAction = null))
        assertEquals(listOf("ABANDON" to ExceptionCards.PressTier.PRIMARY, "OPEN_LANDING" to ExceptionCards.PressTier.SECONDARY),
            mine.map { it.action to it.tier })
        assertEquals(ExceptionCards.abandon to "Ends this attempt. Nothing was pushed, and nothing is queued again.",
            mine[0].label to mine[0].consequence)
        assertEquals(ExceptionCards.openLanding to "Open the landing: every attempt, step by step.", mine[1].label to mine[1].consequence)
        // J12: a check never pushes; a v2 claim that recorded none proves nothing was pushed; anything else may have been.
        assertEquals("Ends this attempt. Nothing was pushed, and nothing is queued again.",
            ExceptionCards.actionConsequence(xe5(lease = lease(jobKind = "CHECK_PROMOTION")), "ABANDON"))
        assertEquals("Ends this attempt. Nothing was pushed, and nothing is queued again.",
            ExceptionCards.actionConsequence(xe5(lease = lease(jobKind = "LAND_TASK", protocol = "v2", pushed = false)), "ABANDON"))
        listOf(lease(jobKind = "LAND_TASK", protocol = "v2", pushed = true), lease(jobKind = "LAND_TASK", protocol = null),
            lease(jobKind = "LAND_PROMOTION", protocol = null), JsonNull).forEach { facts ->
            assertEquals("J12: ${facts}", ExceptionCards.abandonMayHavePushed, ExceptionCards.actionConsequence(xe5(lease = facts), "ABANDON"))
        }
    }

    /** X-E5's heading is the fact it is about — how long the claim has been silent — never "no one acted on this for 1s", and its footer
     * says the wait alone because there is no window the coordinator had it through. */
    @Test fun theXe5HeadingAndFooterSayHowLongTheRunnerHasBeenSilent() {
        val item = xe5(lease = lease(expiredAt = null), waitingSince = "2026-09-21T11:57:00Z", escalatedAt = "2026-09-21T11:57:00Z")
        assertEquals("Now yours — no report from the runner for 27m", ExceptionCards.headingLine(item, now))
        assertEquals(27, ExceptionCards.leaseSilentMinutes(item))
        assertEquals("Owner: you · waiting 3m", ExceptionCards.ownerLine(item, now))
        assertEquals("a row from before the facts names no minutes", "Now yours — no report from the runner",
            ExceptionCards.heading(xe5(lease = JsonNull), now))
        // The lease block: which landing, on which runner and since when, and where it stopped — in board v4 06 c's three rows.
        val facts = ExceptionCards.facts(xe5(facts = Wire.json.parseToJsonElement("""{"task":{"title":"Land · Wire the page"}}"""))) as ExceptionCards.Facts.Rows
        assertEquals(listOf("Landing", "Runner", "Step"), facts.rows.map { it.label })
        assertEquals("Land · Wire the page · generation 2", facts.rows[0].value)
        assertTrue("Runner " + facts.rows[1].value, facts.rows[1].value.startsWith("workstation-gpu · last report "))
        assertEquals("rebasing · claim 1 · round 1 of 3", facts.rows[2].value)
        // An item an older build opened carries no lease and keeps the sentence it always did.
        assertEquals(ExceptionCards.Facts.DetailLine("the run ended with exit code 1"),
            ExceptionCards.facts(row(kind = "LANDING_LEASE_EXPIRED", lease = JsonNull)))
        assertTrue("X-E5 is closed by hand like the other exceptions", ExceptionCards.markable(xe5()))
    }

    /** The Step row's M is the job kind's most rounds per claim (§7.2 V6), never `checkCount`: a landing is "of 3" with two checks or
     * one, the two merge kinds have one round and name none, and so does a kind this build does not know. */
    @Test fun theXe5StepRowTakesTheRoundsMFromTheJobKind() {
        fun step(lease: JsonObject) = (ExceptionCards.facts(xe5(lease = lease)) as ExceptionCards.Facts.Rows).rows
            .first { it.label == ExceptionCards.stepFactLabel }.value
        assertEquals("rebasing · claim 1 · round 2 of 3", step(lease(round = 2, checks = 2)))
        assertEquals("rebasing · claim 1 · round 1 of 3", step(lease(checks = 1)))
        assertEquals("checking · claim 1 · round 1", step(lease(jobKind = "CHECK_PROMOTION", phase = "CHECK")))
        assertEquals("pushing · claim 1 · round 1", step(lease(jobKind = "LAND_PROMOTION", phase = "PUSH", checks = 1)))
        assertEquals("rebasing · claim 1 · round 1", step(lease(jobKind = "SOMETHING_NEW")))
    }

    // MARK: what the card opens with

    @Test fun theCardOpensWithWhatHasToHappenNextAndWhoIsOnIt() {
        val said = row(requiredAction = "Nothing on the project branch reaches main until this check passes — re-run it or ask the coordinator to fix it.")
        assertEquals("Nothing on the project branch reaches main until this check passes — re-run it or ask the coordinator to fix it.",
            ExceptionCards.requiredAction(said))
        assertEquals("an older server's row opens with the fact that opened it", "the run ended with exit code 1", ExceptionCards.requiredAction(row()))
        assertEquals(ExceptionCards.requiredActionFallback, ExceptionCards.requiredAction(row(detailLine = "")))
        assertNull(ExceptionCards.handledByLine(row()))
        assertNull(ExceptionCards.handledByLine(row(handledBy = emptyList())))
        assertEquals("The coordinator is fixing this in Fix the branch. · The coordinator is fixing this in Re-check later.",
            ExceptionCards.handledByLine(row(handledBy = listOf("Fix the branch", "Re-check later"))))
    }

    /** Board card-ui-polish ① (OrbitKit `testALiveRepairIsOneLinkedLineAndQuietDoors`, web `liveRepairs`): any `handledBy` entry not DONE
     * or CANCELLED — the server's own `hasLiveFix` — is a live repair, and turns the card into one linked line and quiet doors with no
     * line under them. Once every repair has ended the card is the plain one again. The words are the browser's and OrbitKit's. */
    @Test fun aLiveRepairIsOneLinkedLineAndQuietDoors() {
        val live = row(kind = "INTEGRATION_CHECK_FAILED", actions = listOf("ASK_COORDINATOR_AGAIN", "RETRY", "OPEN_TASK_SESSION"),
            handledBy = listOf("Fix the branch", "Re-check later"), handledByStates = listOf("IN_PROGRESS", "OPEN"))
        assertEquals(listOf("Fix the branch", "Re-check later"), ExceptionCards.liveRepairs(live).map { it.text("title") })
        assertTrue(ExceptionCards.fixing(live))
        val ended = row(handledBy = listOf("Fix the branch", "Re-check later"), handledByStates = listOf("DONE", "CANCELLED"))
        assertTrue(ExceptionCards.liveRepairs(ended).isEmpty())
        assertFalse(ExceptionCards.fixing(ended))
        assertFalse(ExceptionCards.fixing(row()))
        val quiet = ExceptionCards.presses(live, quiet = true)
        assertTrue(quiet.isNotEmpty())
        assertTrue("a repair in flight asks nothing of the reader", quiet.all { it.tier == ExceptionCards.PressTier.LINK && it.consequence.isEmpty() })
        assertTrue(ExceptionCards.presses(live).any { it.tier != ExceptionCards.PressTier.LINK && it.consequence.isNotEmpty() })
        val web = File(root(), "src/web/src/components/ProjectProgressStatus.tsx").readText()
        assertTrue(web.contains("export const FIXING_TAG = '${ExceptionCards.fixingTag}';"))
        assertTrue(web.contains("export const BEING_FIXED_IN = '${ExceptionCards.beingFixedIn}';"))
        assertTrue(web.contains("export const FIXING_NOTHING_FOR_YOU = '${ExceptionCards.fixingNothingForYou}';"))
        assertTrue(web.contains("row.handledBy ?? []).filter((task) => task.state !== 'DONE' && task.state !== 'CANCELLED')"))
        val swift = File(root(), "src/macos/OrbitKit/Sources/OrbitKit/App/OwnerItemCards.swift").readText()
        assertTrue(swift.contains("public static let fixingTag = \"${ExceptionCards.fixingTag}\""))
        assertTrue(swift.contains("public static let beingFixedIn = \"${ExceptionCards.beingFixedIn}\""))
        assertTrue(swift.contains("public static let fixingNothingForYou = \"${ExceptionCards.fixingNothingForYou}\""))
        assertTrue(swift.contains("\$0.state != \"DONE\" && \$0.state != \"CANCELLED\""))
    }

    /** The Into row names the branch a person knows, never the ref the server stores it under (OrbitKit `testTheIntoRowNamesTheBranchNotItsRef`). */
    @Test fun theIntoRowNamesTheBranchNotItsRef() {
        val facts = ExceptionCards.facts(row(facts = Wire.json.parseToJsonElement(
            """{"targetRef":"refs/heads/main","targetSha":"928ed7e0000","nothingLanded":true}"""))) as ExceptionCards.Facts.Rows
        assertEquals("main at 928ed7e · nothing landed", facts.rows.single { it.label == ExceptionCards.intoLabel }.value)
    }

    /** 2026-11-15: an escalated card said "no one acted on this" over doors and a chat that could not reach the coordinator. With the
     * server reading it unreachable the heading says so, in web's and Apple's words; reachable, or from an older server, it is unchanged. */
    @Test fun anEscalatedItemWhoseCoordinatorCannotBeReachedSaysSo() {
        val unreachable = row(coordinatorUnreachable = true, actions = listOf("OPEN_TASK_SESSION", "CANCEL_TASK"))
        assertEquals("Now yours — the coordinator can’t take messages", ExceptionCards.headingLine(unreachable, now))
        assertEquals("Now yours — the coordinator didn’t get to it", ExceptionCards.headingLine(row(coordinatorUnreachable = false), now))
        assertEquals("Now yours — the coordinator didn’t get to it", ExceptionCards.headingLine(row(), now))
        val web = File(root(), "src/web/src/components/ProjectProgressStatus.tsx").readText()
        assertTrue(web.contains("'${ExceptionCards.escalatedUnreachableHeading}'"))
        val swift = File(root(), "src/macos/OrbitKit/Sources/OrbitKit/App/OwnerItemCards.swift").readText()
        assertTrue(swift.contains("\"${ExceptionCards.escalatedUnreachableHeading}\""))
        val push = File(root(), "src/apiserver/src/push/owner-item-alert.ts").readText()
        assertTrue(push.contains("'${ExceptionCards.escalatedUnreachableHeading}'"))
    }

    @Test fun theHeadingAndTheFooterSayHowItBecameTheOwnersAndForHowLong() {
        assertEquals("Now yours — the coordinator didn’t get to it", ExceptionCards.headingLine(row(), now))
        assertEquals("Task failed: P5.1 Route Handlers", ExceptionCards.subject(row(), now))
        assertEquals("Now yours — the coordinator conversation ended", ExceptionCards.heading(row(reason = "COORDINATOR_ENDED"), now))
        assertEquals("Now yours — the 3rd failure in this chain", ExceptionCards.heading(row(reason = "CHAIN_LIMIT"), now))
        assertEquals("Now yours — the coordinator handed it over", ExceptionCards.heading(row(reason = "HANDED_OVER"), now))
        assertEquals("Now yours — this project has no coordinator", ExceptionCards.heading(row(reason = "NO_COORDINATOR"), now))
        val pause = row(kind = "FUSE_PAUSED", reason = "DEFAULT", escalatedAt = null, title = "Coordinator paused — 3 self-started runs today")
        assertEquals("the heading slot never opens blank", pause.text("title"), ExceptionCards.headingLine(pause, now))
        assertNull(ExceptionCards.subject(pause, now))
        assertEquals("a while", ExceptionCards.waitedBeforeEscalation(row(escalatedAt = null)))
        assertEquals("1s", ExceptionCards.waitedBeforeEscalation(row(escalatedAt = "2026-09-19T18:00:00Z")))
        assertEquals("Owner: you · waiting 1d 16h · came to the owner at 2h", ExceptionCards.ownerLine(row(), now))
        assertEquals("Owner: you · waiting 15m", ExceptionCards.ownerLine(row(escalatedAt = null, waitingSince = "2026-09-21T11:45:00Z"), now))
    }

    // MARK: the doors, their weights and their lines

    @Test fun theThreeWeightsFollowTheServerThenTheKind() {
        fun served(kind: String, actions: List<String>, assignee: String = "COORDINATOR") =
            ExceptionCards.presses(row(kind = kind, actions = actions, assignee = assignee, reason = if (assignee == "OWNER") "ESCALATED" else "DEFAULT",
                delivery = "489fc485")).map { it.action to it.tier }
        val coordinator = listOf("OPEN_COORDINATOR", "OPEN_TASK_SESSION", "RETRY", "CANCEL_TASK")
        val primary = ExceptionCards.PressTier.PRIMARY; val secondary = ExceptionCards.PressTier.SECONDARY; val link = ExceptionCards.PressTier.LINK
        assertEquals(listOf("OPEN_TASK_SESSION" to primary, "RETRY" to secondary, "OPEN_COORDINATOR" to link, "CANCEL_TASK" to link),
            served("INTEGRATION_CONFLICT", coordinator))
        assertEquals(listOf("RETRY" to primary, "OPEN_TASK_SESSION" to secondary, "OPEN_COORDINATOR" to link, "CANCEL_TASK" to link),
            served("TASK_FAILED", coordinator))
        assertEquals("a kind the design names no step for keeps the server's order", listOf("OPEN_TASK_SESSION", "RETRY", "OPEN_COORDINATOR", "CANCEL_TASK"),
            served("INTEGRATION_ERROR", coordinator).map { it.first })
        assertEquals("the owner's card leads with the way back to the coordinator",
            listOf("ASK_COORDINATOR_AGAIN" to primary, "OPEN_TASK_SESSION" to secondary, "CANCEL_TASK" to link),
            served("TASK_FAILED", listOf("ASK_COORDINATOR_AGAIN", "OPEN_TASK_SESSION", "CANCEL_TASK"), assignee = "OWNER"))
        // The server's primaryAction leads whenever the row lists it; one it does not list is no door.
        val led = ExceptionCards.presses(row(kind = "INTEGRATION_CONFLICT", actions = listOf("OPEN_TASK_SESSION", "RETRY", "CANCEL_TASK"), primaryAction = "RETRY"))
        assertEquals(listOf("RETRY" to primary, "OPEN_TASK_SESSION" to secondary, "CANCEL_TASK" to link), led.map { it.action to it.tier })
        assertEquals(listOf("ASK_COORDINATOR_AGAIN"), ExceptionCards.presses(row(actions = listOf("ASK_COORDINATOR_AGAIN"), primaryAction = "RETRY")).map { it.action })
        // A door the row carries no address for is not drawn, and an action this build cannot name is not a door.
        assertEquals(listOf("ASK_COORDINATOR_AGAIN"), ExceptionCards.drawn(row(taskId = null, sessionId = null,
            actions = listOf("ASK_COORDINATOR_AGAIN", "OPEN_TASK_SESSION", "RETRY", "CANCEL_TASK"))))
        assertEquals(listOf("ASK_COORDINATOR_AGAIN"), ExceptionCards.drawn(row(actions = listOf("SOMETHING_NEW", "ASK_COORDINATOR_AGAIN"))))
    }

    @Test fun everyDoorWearsItsLabelAndTheLineSayingWhatPressingItDoes() {
        val conflict = row(kind = "INTEGRATION_CONFLICT", assignee = "COORDINATOR", reason = "DEFAULT", delivery = "s",
            actions = listOf("OPEN_COORDINATOR", "OPEN_TASK_SESSION", "RETRY", "CANCEL_TASK"))
        val doors = ExceptionCards.presses(conflict)
        assertEquals(listOf("Open task session", "Retry", "Open coordinator", "Cancel task"), doors.map { it.label })
        assertEquals(listOf("Open the task session to repair the branch.", "A new integration attempt is queued with your reason.",
            "Open the coordinator conversation.", "The task is cancelled and its open item closes."), doors.map { it.consequence })
        // RETRY's other two sets of words: the candidate's re-check, and a failed task's run again.
        val candidate = ExceptionCards.presses(row(kind = "INTEGRATION_CHECK_FAILED", promotionId = "pr1", taskId = null, sessionId = null,
            actions = listOf("ASK_COORDINATOR_AGAIN", "RETRY"))).single { it.action == "RETRY" }
        assertEquals(ExceptionCards.rerunCheck to ExceptionCards.promotionRetryConsequence, candidate.label to candidate.consequence)
        val runAgain = ExceptionCards.presses(row(actions = listOf("ASK_COORDINATOR_AGAIN", "OPEN_TASK_SESSION", "RETRY"))).single { it.action == "RETRY" }
        assertEquals(ExceptionCards.retry to ExceptionCards.taskRunAgainConsequence, runAgain.label to runAgain.consequence)
        assertEquals("It goes back to the coordinator with a fresh escalation clock.", ExceptionCards.actionConsequence(row(), "ASK_COORDINATOR_AGAIN"))
        assertEquals("The coordinator resumes and held work can continue.", ExceptionCards.actionConsequence(row(kind = "FUSE_PAUSED"), "RESUME"))
        assertEquals("Only if you dealt with it yourself. Your reason goes on the record.", ExceptionCards.markHandledConsequence)
    }

    /** A pause is a card of its own: one Resume, prominent, and none of the three weights. */
    @Test fun aPauseDrawsItsOneResumeProminent() {
        val pause = row(kind = "FUSE_PAUSED", reason = "DEFAULT", taskId = null, sessionId = null, fuseEpisodeId = "ep1", actions = listOf("RESUME"))
        assertEquals(listOf(ExceptionCards.CardPress("RESUME", ExceptionCards.PressTier.PRIMARY, "Resume", "The coordinator resumes and held work can continue.")),
            ExceptionCards.cardPresses(pause))
        assertEquals(CardVerb.RESUME, ExceptionCards.verb(pause, "RESUME"))
        assertTrue(CardVerb.RESUME in cards(pause).single().actions)
        assertFalse(ExceptionCards.markable(pause))
        val other = row(kind = "INTEGRATION_CONFLICT", actions = listOf("ASK_COORDINATOR_AGAIN", "OPEN_TASK_SESSION"))
        assertEquals(ExceptionCards.presses(other), ExceptionCards.cardPresses(other))
    }

    /** `Review` is a way to the merge card and nothing else: drawn only where that card is in this conversation. */
    @Test fun reviewIsDrawnOnlyWhereTheMergeCardIs() {
        val promoted = row(kind = "INTEGRATION_ERROR", promotionId = "pr-1", actions = listOf("REVIEW", "ASK_COORDINATOR_AGAIN"))
        assertEquals(listOf("REVIEW", "ASK_COORDINATOR_AGAIN"), ExceptionCards.drawn(promoted, mergeCard = "pr-1"))
        assertEquals(listOf("ASK_COORDINATOR_AGAIN"), ExceptionCards.drawn(promoted, mergeCard = "pr-other"))
        assertEquals("no merge card here is no Review", listOf("ASK_COORDINATOR_AGAIN"), ExceptionCards.drawn(promoted))
        assertEquals(listOf("ASK_COORDINATOR_AGAIN" to ExceptionCards.PressTier.PRIMARY, "REVIEW" to ExceptionCards.PressTier.LINK),
            ExceptionCards.presses(promoted, mergeCard = "pr-1").map { it.action to it.tier })
        assertNull("Review only looks: it sends nothing", ExceptionCards.verb(promoted, "REVIEW"))
        assertEquals("orbit-session:489fc485-949c-533a-9b56-7712a68762ef", ExceptionCards.openTaskSessionLink(row()))
        assertEquals("orbit-task:t9", ExceptionCards.openTaskSessionLink(row(sessionId = null, taskId = "t9")))
    }

    /** The owner's own ending: offered on the owner's item of a kind closed by hand, and never sent without a reason. */
    @Test fun theOwnersEndingNeedsAReasonAndStopsWhereTheDoorDoes() {
        assertTrue(ExceptionCards.markable(row()))
        assertFalse(ExceptionCards.markable(row(assignee = "COORDINATOR")))
        listOf("COORDINATOR_QUESTION", "PROMOTION_APPROVAL", "FUSE_PAUSED").forEach { assertFalse(it, ExceptionCards.markable(row(kind = it))) }
        listOf("INTEGRATION_CONFLICT", "INTEGRATION_CHECK_FAILED", "INTEGRATION_ERROR", "TASK_FAILED", "DELIVERY_REVIEW").forEach {
            assertTrue(it, ExceptionCards.markable(row(kind = it)))
            assertTrue(it, CardVerb.MARK_HANDLED in cards(row(kind = it)).single().actions)
        }
        val card = cards(row()).single()
        assertThrows(IllegalArgumentException::class.java) { CardRequests.build(card, CardVerb.MARK_HANDLED, CardInput(text = "   ")) }
        assertThrows(IllegalArgumentException::class.java) { CardRequests.build(card, CardVerb.MARK_HANDLED, CardInput(text = "x".repeat(2_001))) }
        val handled = CardRequests.build(card, CardVerb.MARK_HANDLED, CardInput(text = "  landed by hand  "))
        assertEquals(listOf("projects", "p1", "open-items", "01a0bb0b-b3fb-744c-b9a6-2fd68b4420b4", "resolve"), handled.path)
        assertEquals("landed by hand", body(handled).text("note"))
        assertEquals(2_000, ExceptionCards.markHandledMaxLength)
    }

    /** A delivery review is closed by hand like the other exceptions (iOS 262153779): the server's `HAND_CLOSABLE_RESOLUTIONS` and
     * OrbitKit's `handClosableKinds` take it, and a coordinator's item of the kind is still not the owner's to close. */
    @Test fun aDeliveryReviewIsClosedByHandAsTheServerAndOrbitKitHaveIt() {
        val server = File(root(), "src/apiserver/src/projects/project-open-item.service.ts").readText()
            .substringAfter("const HAND_CLOSABLE_RESOLUTIONS").substringBefore("};")
        assertTrue("the server no longer closes a delivery review by hand", server.contains("[DELIVERY_REVIEW_KIND]: 'HANDLED'"))
        val swift = File(root(), "src/macos/OrbitKit/Sources/OrbitKit/App/OwnerItemCards.swift").readText()
            .substringAfter("static let handClosableKinds").substringBefore("]")
        assertTrue("OrbitKit no longer closes a delivery review by hand", swift.contains(".deliveryReview,"))
        val review = row(kind = "DELIVERY_REVIEW", actions = listOf("ASK_COORDINATOR_AGAIN", "RETRY"))
        assertTrue(ExceptionCards.markable(review))
        assertTrue(CardVerb.MARK_HANDLED in cards(review).single().actions)
        assertFalse(ExceptionCards.markable(row(kind = "DELIVERY_REVIEW", assignee = "COORDINATOR")))
        assertFalse(CardVerb.MARK_HANDLED in cards(row(kind = "DELIVERY_REVIEW", assignee = "COORDINATOR")).single().actions)
    }

    // MARK: revision 29's two items (§10.7, §10.8)

    private val landedRequired = "This work reached main without your confirmation — accept it, or use Chat about this to have the " +
        "coordinator file a task that reverts it."
    private fun landed(taskId: String? = "t1", sessionId: String? = null, actions: List<String> = listOf("ACCEPT", "OPEN_TASK_SESSION")) =
        row(kind = "LANDED_WITHOUT_CONFIRMATION", reason = "DEFAULT", escalatedAt = null, taskId = taskId, sessionId = sessionId, actions = actions,
            primaryAction = "ACCEPT", requiredAction = landedRequired, title = "Reached main without your confirmation: Fix the login redirect",
            detailLine = "7d3e9b01c2a4 is on main · seen by Orbit")

    /** LANDED_WITHOUT_CONFIRMATION is the owner's from birth: its card wears its own kind word, is headed by its §10.7 title, leads with
     * Accept — the one door that ends it, through the owner's own route — and offers no hand-close. The deploy-time pass's one item per
     * project names no task, and offers Accept alone. */
    @Test fun workThatLandedWithoutYourConfirmationLeadsWithAccept() {
        val item = landed()
        assertEquals(ExceptionCards.landedTitle, ExceptionCards.title(item))
        assertEquals("Reached main without your confirmation: Fix the login redirect", ExceptionCards.headingLine(item, now))
        assertNull("it never became the owner's, so no escalation story heads it", ExceptionCards.subject(item, now))
        assertEquals(ExceptionCards.Facts.DetailLine("7d3e9b01c2a4 is on main · seen by Orbit"), ExceptionCards.facts(item))
        assertEquals(landedRequired, ExceptionCards.requiredAction(item))
        assertEquals(listOf(
            ExceptionCards.CardPress("ACCEPT", ExceptionCards.PressTier.PRIMARY, "Accept", "You accept the work as it landed, and this item closes."),
            ExceptionCards.CardPress("OPEN_TASK_SESSION", ExceptionCards.PressTier.SECONDARY, "Open task session", "Open the task session to repair the branch."),
        ), ExceptionCards.presses(item))
        assertEquals("orbit-task:t1", ExceptionCards.openTaskSessionLink(item))
        val card = cards(item).single()
        assertEquals("Accept is its one ending: no Mark as handled", listOf(CardVerb.ACCEPT), card.actions)
        assertFalse(ExceptionCards.markable(item))
        val accept = CardRequests.build(card, CardVerb.ACCEPT)
        assertEquals(HttpMethod.POST, accept.method)
        assertEquals(listOf("projects", "p1", "open-items", "01a0bb0b-b3fb-744c-b9a6-2fd68b4420b4", "accept"), accept.path)
        assertEquals(ExceptionCards.notAccepted, ExceptionCards.refusalHeadline(CardVerb.ACCEPT))
        val backfill = landed(taskId = null, actions = listOf("ACCEPT"))
        assertEquals(listOf("ACCEPT"), ExceptionCards.drawn(backfill))
        assertEquals(listOf(CardVerb.ACCEPT), cards(backfill).single().actions)
        assertEquals("the escalation's and the pause's words are theirs", listOf(ExceptionCards.escalatedTitle, ExceptionCards.pauseTitle),
            listOf(ExceptionCards.title(row()), ExceptionCards.title(row(kind = "FUSE_PAUSED"))))
    }

    /** LANDING_UNOBSERVED, handed to the owner: an escalation like any other, headed by how it became theirs with its §10.7 title under
     * it, and Observe again among its doors — quiet beside the way back to the coordinator — whose press needs a reason. The item a
     * project's failing observations open (`IE:observe`) names no task, and Observe again is its one, leading door. */
    @Test fun workNotSeenOnItsLineIsLookedAtAgainWithAReason() {
        val unobserved = row(kind = "LANDING_UNOBSERVED", reason = "HANDED_OVER", actions = listOf("ASK_COORDINATOR_AGAIN", "OPEN_TASK_SESSION", "OBSERVE", "CANCEL_TASK"),
            primaryAction = "ASK_COORDINATOR_AGAIN", title = "Not on main yet: Draw the observation cards",
            detailLine = "Its commit was not found on the line · delivered 3b7e0d91a6c2")
        assertEquals(ExceptionCards.escalatedTitle, ExceptionCards.title(unobserved))
        assertEquals("Now yours — the coordinator handed it over", ExceptionCards.headingLine(unobserved, now))
        assertEquals("Not on main yet: Draw the observation cards", ExceptionCards.subject(unobserved, now))
        val presses = ExceptionCards.presses(unobserved)
        assertEquals(listOf("ASK_COORDINATOR_AGAIN" to ExceptionCards.PressTier.PRIMARY, "OPEN_TASK_SESSION" to ExceptionCards.PressTier.SECONDARY,
            "OBSERVE" to ExceptionCards.PressTier.LINK, "CANCEL_TASK" to ExceptionCards.PressTier.LINK), presses.map { it.action to it.tier })
        assertEquals("Observe again" to "An observation of the line is queued with your reason.", presses[2].label to presses[2].consequence)
        assertEquals(CardVerb.OBSERVE, ExceptionCards.verb(unobserved, "OBSERVE"))
        val card = cards(unobserved).single()
        assertEquals(listOf(CardVerb.RETURN_COORDINATOR, CardVerb.CANCEL_TASK, CardVerb.OBSERVE), card.actions)
        assertFalse("a fact about the task ends it, never a hand-close", ExceptionCards.markable(unobserved))
        // The door requires a reason: none, a blank one or one longer than the door takes is no request.
        assertThrows(IllegalArgumentException::class.java) { CardRequests.build(card, CardVerb.OBSERVE) }
        assertThrows(IllegalArgumentException::class.java) { CardRequests.build(card, CardVerb.OBSERVE, CardInput(text = "   ")) }
        assertThrows(IllegalArgumentException::class.java) { CardRequests.build(card, CardVerb.OBSERVE, CardInput(text = "x".repeat(2_001))) }
        val observe = CardRequests.build(card, CardVerb.OBSERVE, CardInput(text = "  I pushed the rebased commit to main by hand  "))
        assertEquals(HttpMethod.POST, observe.method)
        assertEquals(listOf("projects", "p1", "integration", "observe"), observe.path)
        assertEquals("I pushed the rebased commit to main by hand", body(observe).text("reason"))
        assertEquals(ExceptionCards.notObserved, ExceptionCards.refusalHeadline(CardVerb.OBSERVE))
        val failing = row(kind = "INTEGRATION_ERROR", taskId = null, sessionId = null, actions = listOf("OBSERVE"), primaryAction = "OBSERVE")
        assertEquals(listOf(ExceptionCards.CardPress("OBSERVE", ExceptionCards.PressTier.PRIMARY, "Observe again",
            "An observation of the line is queued with your reason.")), ExceptionCards.presses(failing))
        assertTrue(CardVerb.OBSERVE in cards(failing).single().actions)
    }

    /** §4.7 H1's line while it runs, the browser's `handlingLine`: an observation says its own words, naming the project's main
     * branch; a rerun says which, which generation and where it is; both say since when it was asked, and with what reason. */
    @Test fun theHandlingLineSaysAnObservationInItsOwnWords() {
        fun handled(jobKind: String, state: String, startedAt: String = "2026-09-21T11:58:00Z", promotionId: String? = null) = buildJsonObject {
            row(kind = "LANDING_UNOBSERVED", promotionId = promotionId).forEach { (key, value) -> put(key, value) }
            putJsonObject("handling") { put("sessionId", JsonNull); put("userId", "u1"); put("reason", "I pushed the rebased commit to main by hand")
                put("startedAt", startedAt); put("jobId", "j1"); put("jobKind", jobKind); put("generation", 3); put("state", state) }
        }
        assertEquals("Observing main… — running · asked 2m ago", ExceptionCards.handlingLine(handled("OBSERVE_LANDING", "RUNNING"), now))
        assertEquals("Observing feature/v1.1.1… — queued · asked just now",
            ExceptionCards.handlingLine(handled("OBSERVE_LANDING", "QUEUED", startedAt = "2026-09-21T11:59:55Z"), now, "feature/v1.1.1"))
        assertEquals("the rerun of the landing — generation 3 is queued · asked 2m ago", ExceptionCards.handlingLine(handled("LAND_TASK", "QUEUED"), now))
        assertEquals("the re-check of the merge into master — generation 3 is running · asked 2m ago",
            ExceptionCards.handlingLine(handled("CHECK_PROMOTION", "RUNNING", promotionId = "pr1"), now, "master"))
        assertEquals("I pushed the rebased commit to main by hand", ExceptionCards.handlingReason(handled("OBSERVE_LANDING", "RUNNING")))
        assertNull("nothing is handling it", ExceptionCards.handlingLine(row(), now))
        assertNull(ExceptionCards.handlingReason(row()))
    }

    /** The two doors are the owner's own routes in the server's door table (`open-item-doors.ts`) and its controllers. */
    @Test fun acceptAndObserveAreTheDoorTablesOwnRoutes() {
        val table = File(root(), "src/apiserver/src/projects/open-item-doors.ts").readText()
        listOf("action: 'ACCEPT',", "route: '/projects/:id/open-items/:itemId/accept',", "action: 'OBSERVE',",
            "route: owner ? '/projects/:id/integration/observe' : '/runner/projects/:id/integration/observe',",
        ).forEach { assertTrue("open-item-doors.ts no longer says $it", table.contains(it)) }
        assertTrue(File(root(), "src/apiserver/src/projects/projects.controller.ts").readText().contains("@Post(':id/open-items/:itemId/accept')"))
        assertTrue(File(root(), "src/apiserver/src/projects/project-integration-retry.controller.ts").readText().contains("@Post(':id/integration/observe')"))
    }

    // MARK: the facts

    @Test fun aFailedCheckDrawsItsCommandMonoItsVerdictRedAndItsLogUnderTheCheckRow() {
        val facts = Wire.json.parseToJsonElement("""{"task":{"id":"01a03f58","title":"Verify ScheduleWakeup across warm recycling"},
            "targetRef":"project/bg-jobs","targetSha":"b70a4461c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7","files":[],"nothingLanded":false,
            "check":{"name":"MERGE_CHECK","command":"cd src/runner-go && go test -count=1 ./...","expectedExitCode":0,"exitCode":1,"timedOut":false,
              "durationMs":340000,"outputTail":"\u001b[31m--- FAIL: TestScheduleWakeup\u001b[0m\n    wake_test.go:88: wake not delivered\nFAIL\torbit\t341.207s"},
            "branchUnchanged":true,"errorCode":null,"failure":null}""")
        val block = ExceptionCards.facts(row(kind = "INTEGRATION_CHECK_FAILED", facts = facts)) as ExceptionCards.Facts.Rows
        assertEquals(listOf("Task", "Into", "Check", "Branch"), block.rows.map { it.label })
        assertEquals("project/bg-jobs at b70a446", block.rows[1].value)
        assertEquals(listOf(ExceptionCards.Run("cd src/runner-go && go test -count=1 ./...", ExceptionCards.Face.MONO), ExceptionCards.Run(" · "),
            ExceptionCards.Run("exit 1", ExceptionCards.Face.BAD), ExceptionCards.Run(" after 5m 40s")), block.rows[2].runs)
        assertEquals(ExceptionCards.branchUnchanged, block.rows[3].value)
        val tail = block.logTail!!
        assertEquals(listOf("--- FAIL: TestScheduleWakeup", "    wake_test.go:88: wake not delivered", "FAIL\torbit\t341.207s"), tail.lines)
        assertNull(tail.more)
        assertSame("the log hangs off the Check row", tail, block.rows[2].logTail)
        assertEquals(1, block.rows.count { it.logTail != null })
    }

    /** The Branch row says what the server wrote for the job the check failed in: a task's landing keeps the task's sentence, a promotion
     * of the project branch or of one task's branch says only that the branch did not move and nothing reached main. */
    @Test fun theBranchRowIsTheServersSentenceForTheJobTheCheckFailedIn() {
        fun branchOf(extra: String): String? {
            val facts = Wire.json.parseToJsonElement("""{"task":null,"targetRef":null,"targetSha":null,"files":[],"nothingLanded":false,
                "check":{"command":"npm test","exitCode":1,"expectedExitCode":0,"durationMs":14400000},"errorCode":null,"failure":null$extra}""")
            val block = ExceptionCards.facts(row(kind = "INTEGRATION_CHECK_FAILED", facts = facts)) as ExceptionCards.Facts.Rows
            return block.rows.firstOrNull { it.label == ExceptionCards.branchLabel }?.value
        }
        val project = "unchanged — the project branch did not move, and nothing reached main"
        val candidate = "unchanged — this task’s branch did not move, and nothing on it reached main"
        assertEquals(project, branchOf(""","branchUnchanged":true,"branchLine":"$project""""))
        assertEquals(candidate, branchOf(""","branchUnchanged":true,"branchLine":"$candidate""""))
        assertEquals("unchanged — the task passed on its own branch; it fails only on the combined tree",
            branchOf(""","branchUnchanged":true,"branchLine":"${ExceptionCards.branchUnchanged}""""))
        assertEquals("a server older than branchLine leaves the task's sentence", ExceptionCards.branchUnchanged, branchOf(""","branchUnchanged":true"""))
        assertNull(branchOf(""","branchUnchanged":false,"branchLine":null"""))
    }

    @Test fun aLongLogFoldsFromItsEndAndQuietRowsDrawNoBlankBlocks() {
        val written = (1..9).joinToString("\n") { "line $it" }
        val tail = ExceptionCards.CheckTail.of(written)!!
        assertEquals(3, tail.hidden); assertEquals((4..9).map { "line $it" }, tail.shown); assertEquals("Show 3 more lines", tail.more)
        assertNull(ExceptionCards.CheckTail.of("   \n  ")); assertNull(ExceptionCards.CheckTail.of(null))
        val conflict = ExceptionCards.facts(row(kind = "INTEGRATION_CONFLICT", facts = Wire.json.parseToJsonElement("""{"task":{"id":"t","title":"Wake a session when an event happens"},
            "targetRef":"project/bg-jobs","targetSha":"b70a4461c2","files":["src/runner-go/session_pool.go","background.go"],"nothingLanded":true}"""))) as ExceptionCards.Facts.Rows
        assertEquals(listOf(ExceptionCards.FactRow("Task", "Wake a session when an event happens"), ExceptionCards.FactRow("Into", "project/bg-jobs at b70a446 · nothing landed"),
            ExceptionCards.FactRow("Files", "src/runner-go/session_pool.go · background.go", mono = true), ExceptionCards.FactRow("After a fix", ExceptionCards.afterAFix)),
            conflict.rows)
        val failure = ExceptionCards.facts(row(facts = Wire.json.parseToJsonElement("""{"failure":{"how":"ACCEPTANCE_EXIT_MISMATCH","exitCode":1,"expectedExitCode":0,"attempt":2,"limit":3}}"""))) as ExceptionCards.Facts.Rows
        assertEquals(listOf("the acceptance command exited 1 (expected 0)", "attempt 2 of 3 in this chain — the 3rd failure goes straight to the owner"), failure.rows.map { it.value })
        assertEquals("the task failed", ExceptionCards.howFailed(buildJsonObject { put("how", "SOMETHING_NEW") }))
        assertNull(ExceptionCards.chainStanding(buildJsonObject { put("how", "RUN_FAILED") }))
        assertEquals("attempt 3 of 3 in this chain — this one is the owner's", ExceptionCards.chainStanding(buildJsonObject { put("attempt", 3); put("limit", 3) }))
        assertEquals(listOf("1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "22nd"), listOf(1, 2, 3, 4, 11, 12, 13, 22).map(ExceptionCards::ordinal))
        assertEquals("no payload is the server's own sentence", ExceptionCards.Facts.DetailLine("the run ended with exit code 1"), ExceptionCards.facts(row()))
        assertEquals(ExceptionCards.Facts.Rows(emptyList()), ExceptionCards.facts(row(facts = buildJsonObject { })))
        val quiet = ExceptionCards.facts(row(facts = Wire.json.parseToJsonElement("""{"check":{"command":"npm test","exitCode":1,"durationMs":48000}}"""))) as ExceptionCards.Facts.Rows
        assertEquals(listOf("npm test · exit 1 after 48s"), quiet.rows.map { it.value }); assertNull(quiet.logTail)
        assertEquals("timed out", ExceptionCards.checkVerdict(buildJsonObject { put("timedOut", true) }))
        assertEquals(listOf("48s", "6m 12s", "1h 4m", "2h", "0s"), listOf(48_000.0, 372_000.0, 3_840_000.0, 7_200_000.0, -5.0).map(ExceptionCards::checkDuration))
    }

    // MARK: the words are iOS's

    @Test fun everyWordIsOrbitKits() {
        val swift = File(root(), "src/macos/OrbitKit/Sources/OrbitKit/App/OwnerItemCards.swift").readText()
            .replace(Regex("\"\\s*\\n\\s*\\+\\s*\""), "")
        listOf(ExceptionCards.escalatedTitle, ExceptionCards.pauseTitle, ExceptionCards.provenance, ExceptionCards.gone, ExceptionCards.requiredActionFallback,
            ExceptionCards.openTaskSession, ExceptionCards.retry, ExceptionCards.rerunCheck, ExceptionCards.promotionRetryConsequence,
            ExceptionCards.taskRunAgainConsequence, ExceptionCards.retryReasonFallback, ExceptionCards.markHandledConsequence, ExceptionCards.markHandled,
            ExceptionCards.markHandledTitle, ExceptionCards.markHandledBody, ExceptionCards.markHandledReason, ExceptionCards.notMarkedHandled,
            ExceptionCards.notRerunCheck, ExceptionCards.notRetriedLanding, ExceptionCards.notRunAgain, ExceptionCards.notReturned, ExceptionCards.notResumed,
            ExceptionCards.ownerPrefix, ExceptionCards.cameToOwnerAt, ExceptionCards.nothingLanded, ExceptionCards.afterAFix, ExceptionCards.branchUnchanged,
            ExceptionCards.openLanding, ExceptionCards.abandon, ExceptionCards.abandonMayHavePushed, ExceptionCards.notAbandoned,
            ExceptionCards.landingFactLabel, ExceptionCards.runnerFactLabel, ExceptionCards.stepFactLabel, ExceptionCards.generationWord,
            ExceptionCards.lastReportWord, ExceptionCards.leaseExpiredWord, ExceptionCards.theRunnerWord,
            "Open the landing: every attempt, step by step.", "Ends this attempt. Nothing was pushed, and nothing is queued again.",
            ExceptionCards.CheckTail.less, "Review", "Answer", "Open coordinator", "Cancel task", "Ask the coordinator again",
            "Open the current merge card.", "Record your answer on the coordinator question.", "The coordinator resumes and held work can continue.",
            "Open the coordinator conversation.", "Open the task session to repair the branch.", "A new integration attempt is queued with your reason.",
            "The task is cancelled and its open item closes.", "It goes back to the coordinator with a fresh escalation clock.",
        ).forEach { assertTrue("OwnerItemCards.swift no longer says \"$it\"", swift.contains("\"$it\"")) }
        listOf("Now yours — the coordinator conversation ended", "Now yours — the 3rd failure in this chain",
            "Now yours — the coordinator handed it over", "Now yours — the coordinator can’t take messages",
            "The coordinator is fixing this in \\(\$0.title).", "attempt \\(attempt) of \\(limit) in this chain", "Show \\(hidden) more lines",
        ).forEach { assertTrue("OwnerItemCards.swift no longer says $it", swift.contains(it)) }
        assertTrue(swift.contains("public static let foldedLines = ${ExceptionCards.CheckTail.foldedLines}"))
        assertTrue(swift.contains("public static let markHandledMaxLength = 2_000"))
        val projectPage = File(root(), "src/macos/OrbitKit/Sources/OrbitKit/App/ProjectPage.swift").readText()
        assertTrue("the rounds one LAND_TASK claim can run (iOS ProjectPage)",
            projectPage.contains("public static let landTaskRoundsPerClaim = ${ExceptionCards.landTaskRoundsPerClaim}"))
        val needsYou = File(root(), "src/macos/OrbitKit/Sources/OrbitKit/App/NeedsYou.swift").readText()
        assertTrue("the session row's separator", needsYou.contains("public static let needSeparator = \" · \""))
    }

    // MARK: "Who fixes it?" (board docs/mocks/owner-exception-who-fixes, D1–D4 = A; web ProjectProgressStatus.whoFixes.test.tsx)

    private val boardNow = Instant.parse("2026-11-16T12:00:00Z")
    private fun ago(minutes: Long) = boardNow.minusSeconds(minutes * 60).toString()
    private val boardFiles = listOf("src/webhooks/sender.ts", "src/webhooks/sender.test.ts", "src/webhooks/retry-policy.ts", "src/queue/backoff.ts",
        "src/queue/backoff.test.ts", "src/config/defaults.ts", "docs/webhooks.md", "package.json", "package-lock.json")

    /** Board ②'s escalated merge conflict: 3h 1m waiting, 2h 56m of it with the coordinator — reachable unless [unreachable]. */
    private fun conflict(unreachable: Boolean = false, kind: String = "INTEGRATION_CONFLICT", reason: String = "ESCALATED",
        handoverNote: String? = null, chatRefusal: String? = if (unreachable) "COORDINATOR_UNAVAILABLE" else null,
        coordinatorUnreachable: Boolean = unreachable, taskId: String? = "35aTask00000000000001", promotionId: String? = null,
        assignee: String = "OWNER") = buildJsonObject {
        put("itemId", "35aItem0000000000000001"); put("kind", kind); put("title", "Merge conflict: Retry failed webhook deliveries")
        put("detailLine", "9 files conflict with project/35aK2xQm"); put("assignee", assignee); put("assigneeReason", reason)
        put("waitingSince", ago(181)); put("escalateAt", JsonNull); put("escalatedAt", ago(5))
        put("taskId", taskId); put("sessionId", "35aSession000000000001"); put("landingSessionId", "35aLanding00000000001")
        put("promotionId", promotionId); put("fuseEpisodeId", JsonNull)
        putJsonObject("delivery") { put("state", "DELIVERED"); put("sessionId", "35aCoord0000000000001"); put("at", ago(180)) }
        putJsonArray("actions") {
            (if (unreachable) listOf("OPEN_TASK_SESSION", "OPEN_LANDING", "CANCEL_TASK")
            else listOf("ASK_COORDINATOR_AGAIN", "OPEN_TASK_SESSION", "OPEN_LANDING", "CANCEL_TASK")).forEach { add(it) }
        }
        put("question", JsonNull)
        putJsonObject("facts") {
            putJsonObject("task") { put("id", "35aTask00000000000001"); put("title", "Retry failed webhook deliveries") }
            put("targetRef", "refs/heads/project/35aK2xQm8LrT0vHcE1pZq"); put("targetSha", "9f3c2e1aa0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5")
            putJsonArray("files") { boardFiles.forEach { add(it) } }
            put("nothingLanded", false); put("check", JsonNull); put("branchUnchanged", false); put("errorCode", JsonNull); put("failure", JsonNull)
        }
        putJsonObject("chat") { put("sessionId", "35aCoord0000000000001"); put("stage", "WITH_OWNER"); put("refusal", chatRefusal) }
        put("coordinatorUnreachable", coordinatorUnreachable)
        handoverNote?.let { put("handoverNote", it) }
    }

    /** `GET /projects/:id/coordinator/status`, as the frozen contract shapes it. */
    private fun status(state: String, refusalDetail: String? = null, completed: Boolean = false) = buildJsonObject {
        put("projectId", "35aK2xQm8LrT0vHcE1pZq"); put("state", state)
        putJsonObject("coordination") {
            put("sessionId", if (state == "NEVER_OPENED") null else "35aCoord0000000000001")
            if (state == "LIVE") putJsonObject("session") { put("id", "35aCoord0000000000001"); put("lifecycleState", if (completed) "COMPLETED" else "OPEN") }
            else put("session", JsonNull)
            put("workspaceId", if (state == "NEVER_OPENED") null else "35aWorkspace0000000001")
            put("workspaceName", if (state == "NEVER_OPENED") null else "mac-mini")
        }
        putJsonObject("openability") { put("canOpen", state != "UNAVAILABLE"); put("refusalDetail", refusalDetail) }
    }

    private fun workspace(enabled: Boolean, runnerId: String?) = buildJsonObject {
        put("id", "35aWorkspace0000000001"); put("name", "mac-mini"); put("enabled", enabled); put("runnerId", runnerId)
    }

    /** One board part 6 row, read the way the card reads it: the status parsed, and the workspace list only for a LIVE one. */
    private fun read(row: JsonObject, status: JsonObject? = null, workspace: JsonObject? = null): ExceptionCards.CoordinatorReading {
        val parsed = if (ExceptionCards.askable(row)) null else ExceptionCards.CoordinatorStatus.of(status)
        return ExceptionCards.readCoordinatorCause(row, parsed, if (parsed?.state == "LIVE") ExceptionCards.WorkspaceFacts.of(workspace) else null)
    }

    private data class Part6(val cause: ExceptionCards.CoordinatorCause, val reading: ExceptionCards.CoordinatorReading, val row: JsonObject,
        val heading: String, val sentence: String, val presses: List<String>, val leads: String?)

    /** Board part 6, one row per cause: web's PART_6 table, expectation for expectation. */
    private fun part6(): List<Part6> {
        val unreachable = conflict(unreachable = true)
        val ended = conflict(unreachable = true, reason = "COORDINATOR_ENDED")
        val none = conflict(unreachable = true, reason = "NO_COORDINATOR", chatRefusal = "NO_COORDINATOR")
        val handed = conflict(reason = "HANDED_OVER", handoverNote = "The conflict is in your retry policy")
        val cantTake = "Now yours — the coordinator can’t take messages"
        return listOf(
            Part6(ExceptionCards.CoordinatorCause.WORKSPACE_DISABLED, read(unreachable, status("LIVE"), workspace(enabled = false, runnerId = "r1")), unreachable,
                cantTake, "Its workspace mac-mini is disabled, so it can’t take messages.", listOf("Enable mac-mini", "Change workspace…"), "Enable mac-mini"),
            Part6(ExceptionCards.CoordinatorCause.WORKSPACE_TRASHED, read(unreachable, status("UNAVAILABLE", "WORKSPACE_TRASHED")), unreachable,
                cantTake, "Its workspace mac-mini is in Trash, so it can’t take messages.", listOf("Restore mac-mini", "Change workspace…"), "Restore mac-mini"),
            Part6(ExceptionCards.CoordinatorCause.WORKSPACE_UNBOUND, read(unreachable, status("UNAVAILABLE", "WORKSPACE_UNBOUND")), unreachable,
                cantTake, "Its workspace mac-mini isn’t bound to a runner.", listOf("Bind mac-mini to a runner", "Change workspace…"), "Bind mac-mini to a runner"),
            Part6(ExceptionCards.CoordinatorCause.RUNNER_DOWN, read(unreachable, status("LIVE"), workspace(enabled = true, runnerId = "r1")), unreachable,
                cantTake, "Its runner is offline. Ask again comes back here as soon as it is.", listOf("Change workspace…"), null),
            Part6(ExceptionCards.CoordinatorCause.COORDINATOR_ENDED, read(ended, status("LIVE", completed = true)), ended,
                "Now yours — the coordinator conversation ended", "Its conversation was completed.", listOf("Start a new coordinator"), "Start a new coordinator"),
            Part6(ExceptionCards.CoordinatorCause.NO_COORDINATOR, read(none, status("NEVER_OPENED")), none,
                "Now yours — this project has no coordinator", "This project isn’t coordinated.", listOf("Set up a coordinator…"), "Set up a coordinator…"),
            Part6(ExceptionCards.CoordinatorCause.ESCALATED, read(conflict()), conflict(),
                "Now yours — the coordinator didn’t get to it", "Reachable. It had this for 2h 56m and didn’t get to it.",
                listOf("Ask the coordinator again", "or Chat about this first"), "Ask the coordinator again"),
            Part6(ExceptionCards.CoordinatorCause.HANDED_OVER, read(handed), handed,
                "Now yours — the coordinator handed it over", "It handed this to you on purpose.",
                listOf("Ask the coordinator again", "or Chat about this first"), null),
        )
    }

    private fun assertPart6(cause: ExceptionCards.CoordinatorCause) {
        val case = part6().single { it.cause == cause }
        assertEquals(cause, case.reading.cause)
        assertEquals(case.heading, ExceptionCards.whoFixesHeading(case.reading.cause))
        assertEquals(case.sentence, ExceptionCards.coordinatorRowSentence(case.row, case.reading))
        val presses = ExceptionCards.coordinatorRowPresses(case.reading)
        assertEquals(case.presses, presses.map { it.label })
        assertEquals("which press leads", case.leads, presses.firstOrNull { it.tier == ExceptionCards.PressTier.PRIMARY }?.label)
        assertTrue("one primary at most", presses.count { it.tier == ExceptionCards.PressTier.PRIMARY } <= 1)
        assertTrue(ExceptionCards.whoFixesIt(case.row))
    }

    @Test fun part6WorkspaceDisabled() {
        assertPart6(ExceptionCards.CoordinatorCause.WORKSPACE_DISABLED)
        // With a name, Change workspace… is a text link beside the fix.
        val reading = part6().single { it.cause == ExceptionCards.CoordinatorCause.WORKSPACE_DISABLED }.reading
        assertEquals("35aWorkspace0000000001", reading.workspaceId)
        assertEquals(listOf(ExceptionCards.PressTier.PRIMARY, ExceptionCards.PressTier.LINK), ExceptionCards.coordinatorRowPresses(reading).map { it.tier })
    }
    @Test fun part6WorkspaceTrashed() = assertPart6(ExceptionCards.CoordinatorCause.WORKSPACE_TRASHED)
    @Test fun part6WorkspaceUnbound() {
        assertPart6(ExceptionCards.CoordinatorCause.WORKSPACE_UNBOUND)
        // A LIVE conversation whose workspace the list says has no runner reads unbound too.
        assertEquals(ExceptionCards.CoordinatorCause.WORKSPACE_UNBOUND,
            read(conflict(unreachable = true), status("LIVE"), workspace(enabled = true, runnerId = null)).cause)
    }
    @Test fun part6RunnerDown() {
        assertPart6(ExceptionCards.CoordinatorCause.RUNNER_DOWN)
        val reading = part6().single { it.cause == ExceptionCards.CoordinatorCause.RUNNER_DOWN }.reading
        assertEquals(listOf(ExceptionCards.PressTier.SECONDARY), ExceptionCards.coordinatorRowPresses(reading).map { it.tier })
        assertNull("no note under a run that is only down", ExceptionCards.coordinatorRowNote(conflict(unreachable = true), reading))
        assertTrue("Fix it myself leads", ExceptionCards.fixItMyselfLeads(reading))
    }
    @Test fun part6CoordinatorEnded() {
        assertPart6(ExceptionCards.CoordinatorCause.COORDINATOR_ENDED)
        // Every other way a status says the conversation is over.
        assertEquals(ExceptionCards.CoordinatorCause.COORDINATOR_ENDED, read(conflict(unreachable = true), status("TRASHED")).cause)
        assertEquals(ExceptionCards.CoordinatorCause.COORDINATOR_ENDED, read(conflict(unreachable = true), status("UNAVAILABLE", "SOMETHING_ELSE")).cause)
        assertEquals("it takes a message but cannot be asked", ExceptionCards.CoordinatorCause.COORDINATOR_ENDED,
            read(conflict(unreachable = true, coordinatorUnreachable = false), status("LIVE"), workspace(enabled = false, runnerId = "r1")).cause)
    }
    @Test fun part6NoCoordinator() = assertPart6(ExceptionCards.CoordinatorCause.NO_COORDINATOR)
    @Test fun part6Escalated() = assertPart6(ExceptionCards.CoordinatorCause.ESCALATED)
    @Test fun part6HandedOver() {
        assertPart6(ExceptionCards.CoordinatorCause.HANDED_OVER)
        assertEquals("a hand-over with no note still says it was on purpose", "It handed this to you on purpose.",
            ExceptionCards.coordinatorRowSentence(conflict(reason = "HANDED_OVER"), ExceptionCards.CoordinatorReading(ExceptionCards.CoordinatorCause.HANDED_OVER)))
    }

    @Test fun withoutAStatusTheRowAloneDecidesAndNeverClaimsAWorkspace() {
        assertEquals(ExceptionCards.CoordinatorCause.RUNNER_DOWN, read(conflict(unreachable = true)).cause)
        assertEquals(ExceptionCards.CoordinatorCause.COORDINATOR_ENDED, read(conflict(unreachable = true, reason = "COORDINATOR_ENDED")).cause)
        assertEquals(ExceptionCards.CoordinatorCause.COORDINATOR_ENDED, read(conflict(unreachable = true, coordinatorUnreachable = false)).cause)
        assertEquals(ExceptionCards.CoordinatorCause.NO_COORDINATOR, read(conflict(unreachable = true, chatRefusal = "NO_COORDINATOR")).cause)
        assertNull(read(conflict(unreachable = true)).workspaceName)
        val disabledNoName = ExceptionCards.CoordinatorReading(ExceptionCards.CoordinatorCause.WORKSPACE_DISABLED)
        assertEquals("Its workspace is disabled, so it can’t take messages.", ExceptionCards.coordinatorRowSentence(conflict(), disabledNoName))
        assertEquals(listOf(ExceptionCards.RowPress(ExceptionCards.RowPressKind.CHANGE_WORKSPACE, ExceptionCards.PressTier.SECONDARY, "Change workspace…")),
            ExceptionCards.coordinatorRowPresses(disabledNoName))
        // An askable row never reads the status, whatever it says.
        assertEquals(ExceptionCards.CoordinatorCause.ESCALATED,
            ExceptionCards.readCoordinatorCause(conflict(), ExceptionCards.CoordinatorStatus.of(status("NEVER_OPENED"))).cause)
    }

    @Test fun onlyOwnerItemsOfTheFiveKindsByEscalationOrHandOverGetTheCard() {
        for (kind in listOf("INTEGRATION_CONFLICT", "INTEGRATION_CHECK_FAILED", "INTEGRATION_ERROR", "TASK_FAILED", "DELIVERY_REVIEW"))
            assertTrue(kind, ExceptionCards.whoFixesIt(conflict(kind = kind)))
        for (reason in listOf("ESCALATED", "HANDED_OVER", "COORDINATOR_ENDED", "NO_COORDINATOR")) assertTrue(reason, ExceptionCards.whoFixesIt(conflict(reason = reason)))
        assertFalse(ExceptionCards.whoFixesIt(conflict(reason = "CHAIN_LIMIT")))
        assertFalse(ExceptionCards.whoFixesIt(conflict(reason = "DEFAULT")))
        assertFalse(ExceptionCards.whoFixesIt(conflict(assignee = "COORDINATOR")))
        for (kind in listOf("LANDING_LEASE_EXPIRED", "FUSE_PAUSED", "LANDED_WITHOUT_CONFIRMATION")) assertFalse(kind, ExceptionCards.whoFixesIt(conflict(kind = kind)))
    }

    @Test fun d1ARepairPressRepairsTheCoordinatorOnly() {
        val disabled = part6().single { it.cause == ExceptionCards.CoordinatorCause.WORKSPACE_DISABLED }
        for (case in part6().filter { it.row.let { r -> !ExceptionCards.askable(r) } }) {
            val kinds = ExceptionCards.coordinatorRowPresses(case.reading).map { it.kind }
            assertFalse("${case.cause} draws no Ask again until it is back", ExceptionCards.RowPressKind.ASK_AGAIN in kinds)
        }
        assertEquals(ExceptionCards.askAgainOnceBack, ExceptionCards.coordinatorRowNote(disabled.row, disabled.reading))
        // Once the server reads it askable, the same card is the reachable one, in place — the status it read no longer matters.
        val back = read(conflict(), status("LIVE"), workspace(enabled = false, runnerId = "r1"))
        assertEquals(ExceptionCards.CoordinatorCause.ESCALATED, back.cause)
        assertEquals(ExceptionCards.RowPressKind.ASK_AGAIN, ExceptionCards.coordinatorRowPresses(back).first().kind)
        assertEquals("It goes back to the coordinator with a fresh escalation clock.", ExceptionCards.coordinatorRowNote(conflict(), back))
    }

    /** Ask again's note names the project's escalation window, as web's `askAgainFreshClock` does; without one it keeps the standing line. */
    @Test fun askAgainsNoteNamesTheProjectsEscalationWindow() {
        val escalated = read(conflict())
        assertEquals("It goes back to the coordinator with a fresh 2h clock.", ExceptionCards.coordinatorRowNote(conflict(), escalated, 7200))
        assertEquals("It goes back to the coordinator with a fresh 1h 30m clock.", ExceptionCards.coordinatorRowNote(conflict(), escalated, 5400))
        assertEquals("It goes back to the coordinator with a fresh 2h clock.",
            ExceptionCards.coordinatorRowNote(conflict(reason = "HANDED_OVER"), read(conflict(reason = "HANDED_OVER")), 7200))
        assertEquals("It goes back to the coordinator with a fresh escalation clock.", ExceptionCards.coordinatorRowNote(conflict(), escalated))
        assertEquals("It goes back to the coordinator with a fresh escalation clock.", ExceptionCards.coordinatorRowNote(conflict(), escalated, 0))
        // The repair causes keep their own note whatever the window.
        val disabled = part6().single { it.cause == ExceptionCards.CoordinatorCause.WORKSPACE_DISABLED }
        assertEquals(ExceptionCards.askAgainOnceBack, ExceptionCards.coordinatorRowNote(disabled.row, disabled.reading, 7200))
        val web = File(root(), "src/web/src/components/ProjectProgressStatus.tsx").readText()
        assertTrue(web.contains("It goes back to the coordinator with a fresh \${formatSpan(escalationSeconds * 1000)} clock."))
        assertTrue(web.contains("exceptionEscalationSeconds"))
    }

    @Test fun d2NoChatWhenUnreachableAndTheChatLinkBesideAskAgainWhenReachable() {
        for (case in part6()) {
            val kinds = ExceptionCards.coordinatorRowPresses(case.reading).map { it.kind }
            val askable = ExceptionCards.askable(case.row)
            assertEquals(case.cause.name, askable, ExceptionCards.RowPressKind.CHAT_FIRST in kinds)
        }
        val reachable = ExceptionCards.coordinatorRowPresses(read(conflict()))
        assertEquals(listOf(ExceptionCards.RowPressKind.ASK_AGAIN, ExceptionCards.RowPressKind.CHAT_FIRST), reachable.map { it.kind })
        assertEquals(ExceptionCards.PressTier.LINK, reachable[1].tier)
    }

    @Test fun d3OneClockTheTotalWaitAndNoNumberInTheHeading() {
        assertEquals("waiting 3h 1m", ExceptionCards.whoFixesClock(conflict(), boardNow))
        assertFalse(ExceptionCards.escalatedReachableHeading.any { it.isDigit() })
        assertFalse(ExceptionCards.noCoordinatorHeading.any { it.isDigit() })
        // How long the coordinator had it is in Details instead.
        assertEquals("after 2h 56m with the coordinator", ExceptionCards.cameToYouLine(conflict()))
    }

    @Test fun d4AHandOverLeadsWithFixItMyself() {
        val handed = read(conflict(reason = "HANDED_OVER"))
        assertTrue(ExceptionCards.youLead(handed))
        assertTrue(ExceptionCards.fixItMyselfLeads(handed))
        assertEquals(ExceptionCards.PressTier.SECONDARY, ExceptionCards.coordinatorRowPresses(handed).first().tier)
        val escalated = read(conflict())
        assertFalse(ExceptionCards.youLead(escalated))
        assertFalse(ExceptionCards.fixItMyselfLeads(escalated))
        assertEquals(ExceptionCards.PressTier.PRIMARY, ExceptionCards.coordinatorRowPresses(escalated).first().tier)
        for (case in part6().filter { it.cause != ExceptionCards.CoordinatorCause.HANDED_OVER }) assertFalse(case.cause.name, ExceptionCards.youLead(case.reading))
    }

    @Test fun closesByItselfOnlyOnAnIntegrationItemWithATaskBranch() {
        for (kind in listOf("INTEGRATION_CONFLICT", "INTEGRATION_CHECK_FAILED", "INTEGRATION_ERROR")) assertTrue(kind, ExceptionCards.closesByItself(conflict(kind = kind)))
        assertFalse(ExceptionCards.closesByItself(conflict(kind = "TASK_FAILED")))
        assertFalse(ExceptionCards.closesByItself(conflict(kind = "DELIVERY_REVIEW")))
        assertFalse("a candidate's failed check has no task branch",
            ExceptionCards.closesByItself(conflict(kind = "INTEGRATION_CHECK_FAILED", taskId = null, promotionId = "35aPromo0000000000001")))
        assertFalse(ExceptionCards.closesByItself(conflict(promotionId = "35aPromo0000000000001")))
    }

    @Test fun theSublineTheYouLineAndTheFoldedDetails() {
        assertEquals("Merge conflict · Retry failed webhook deliveries → Checkout v2", ExceptionCards.whoFixesSubline(conflict(), "Checkout v2"))
        assertEquals("Merge conflict · Retry failed webhook deliveries", ExceptionCards.whoFixesSubline(conflict(), null))
        assertEquals("Opens the task session. Fix the conflict there and push to the task branch.", ExceptionCards.fixItMyselfLine(conflict()))
        assertEquals("Opens the task session.", ExceptionCards.fixItMyselfLine(conflict(kind = "TASK_FAILED")))
        assertEquals("Details · 9 files · Open landing", ExceptionCards.detailsSummary(conflict(), landing = true))
        assertEquals("Details · 9 files", ExceptionCards.detailsSummary(conflict(), landing = false))
        val rows = ExceptionCards.detailRows(conflict(), "Checkout v2")
        assertEquals(listOf("Into", "Files (9)", "Came to you"), rows.map { it.label })
        // web `shortRef`: the first 16 characters (`name.slice(0, 16)`), so the project id is cut after 8.
        assertEquals("Checkout v2’s branch project/35aK2xQm… at 9f3c2e1", rows[0].value)
        assertEquals("src/webhooks/sender.ts · src/webhooks/sender.test.ts · src/webhooks/retry-policy.ts · src/queue/backoff.ts · " +
            "src/queue/backoff.test.ts and 4 more", rows[1].value)
        assertEquals(ExceptionCards.Face.MONO, rows[1].runs.first().face)
        assertEquals("after 2h 56m with the coordinator", rows[2].value)
        assertFalse(rows.any { it.label == "Task" || it.label == "After a fix" })
    }

    @Test fun theFilesStopAtFive() {
        assertEquals(5, ExceptionCards.detailFilesShown)
        fun files(n: Int) = (ExceptionCards.detailRows(buildJsonObject {
            conflict().forEach { (k, v) -> if (k != "facts") put(k, v) }
            putJsonObject("facts") { putJsonArray("files") { (1..n).forEach { add("f$it.ts") } } }
        }, null).single { it.label.startsWith("Files") })
        assertEquals("f1.ts · f2.ts · f3.ts · f4.ts · f5.ts", files(5).value)
        assertEquals("Files (5)", files(5).label)
        assertEquals("f1.ts · f2.ts · f3.ts · f4.ts · f5.ts and 1 more", files(6).value)
        assertEquals("f1.ts", files(1).value)
    }

    @Test fun theCoordinatorStatusReadIsTheContractsFields() {
        val read = ExceptionCards.CoordinatorStatus.of(status("UNAVAILABLE", "WORKSPACE_DISABLED"))!!
        assertEquals(ExceptionCards.CoordinatorStatus("UNAVAILABLE", "35aWorkspace0000000001", "mac-mini", null, "WORKSPACE_DISABLED"), read)
        assertEquals("COMPLETED", ExceptionCards.CoordinatorStatus.of(status("LIVE", completed = true))!!.sessionLifecycleState)
        assertNull(ExceptionCards.CoordinatorStatus.of(null))
        assertNull(ExceptionCards.CoordinatorStatus.of(buildJsonObject { }))
        // The workspace list predating `runnerId` claims nothing about the binding.
        assertEquals(ExceptionCards.WorkspaceFacts(true, null), ExceptionCards.WorkspaceFacts.of(buildJsonObject { put("enabled", true) }))
        // The contract's fields, by name.
        val contract = File(root(), "docs/project-coordinator-status-contract.md").readText()
        listOf("refusalDetail", "workspaceName", "lifecycleState", "NEVER_OPENED", "UNAVAILABLE", "WORKSPACE_TRASHED", "WORKSPACE_UNBOUND")
            .forEach { assertTrue("the status contract no longer says $it", contract.contains(it)) }
    }

    /** Every new word is web's (`ProjectProgressStatus.tsx`'s "Who fixes it?" section, `coordinatorWorkspace.ts`). */
    @Test fun everyWhoFixesWordIsWebs() {
        val web = File(root(), "src/web/src/components/ProjectProgressStatus.tsx").readText()
        listOf(ExceptionCards.whoFixesIt, ExceptionCards.whoFixesCoordinator, ExceptionCards.whoFixesYou, ExceptionCards.fixItMyself,
            ExceptionCards.startNewCoordinator, ExceptionCards.setUpCoordinator, ExceptionCards.chatFirstLink, ExceptionCards.askAgainOnceBack,
            ExceptionCards.runnerDownSentence, ExceptionCards.coordinatorEndedSentence, ExceptionCards.noCoordinatorSentence, ExceptionCards.handedOverSentence, ExceptionCards.handoverNoteCaption,
            ExceptionCards.closesByItself, ExceptionCards.alreadySettled, ExceptionCards.markHandledSettledConsequence, ExceptionCards.cancelTaskSettledConsequence,
            ExceptionCards.detailsLabel, ExceptionCards.openLandingDetail, ExceptionCards.escalatedUnreachableHeading, ExceptionCards.escalatedReachableHeading,
            ExceptionCards.coordinatorEndedHeading, ExceptionCards.handedOverHeading, ExceptionCards.noCoordinatorHeading,
            ExceptionCards.cameToYouLabel, "Kept the judgment method Orbit questioned", "Changed files it didn’t declare", "Git refused to merge it",
        ).forEach { assertTrue("ProjectProgressStatus.tsx no longer says '$it'", web.contains("'$it'") || web.contains("\"$it\"")) }
        ExceptionCards.whoFixesKind.forEach { (kind, word) -> assertTrue("WHO_FIXES_KIND.$kind", web.contains("$kind: '$word'")) }
        ExceptionCards.fixItMyselfConsequence.forEach { (kind, line) -> assertTrue("FIX_IT_MYSELF_CONSEQUENCE.$kind", web.contains("$kind: '$line'")) }
        assertTrue(web.contains("export const DETAIL_FILES_SHOWN = ${ExceptionCards.detailFilesShown};"))
        listOf("is disabled, so it can’t take messages.`", "is in Trash, so it can’t take messages.`", "isn’t bound to a runner.`",
            "`Reachable. It had this for \${waitedBeforeEscalation(row)} and didn’t get to it.`", "`after \${waitedBeforeEscalation(row)} with the coordinator`",
            "`waiting \${formatSpan(waitedMs(row, now))}`", "`\${folded.projectName}’s branch `", "` and \${facts.files.length - DETAIL_FILES_SHOWN} more`",
            "`\${name.slice(0, 16)}…`", "Its workspace \${reading.workspaceName}",
        ).forEach { assertTrue("ProjectProgressStatus.tsx no longer says $it", web.contains(it)) }
        val workspace = File(root(), "src/web/src/lib/coordinatorWorkspace.ts").readText()
        assertTrue(workspace.contains("button: '${ExceptionCards.changeWorkspace}'"))
        assertEquals("Enable mac-mini", ExceptionCards.fixLabel(ExceptionCards.CoordinatorCause.WORKSPACE_DISABLED, "mac-mini"))
        listOf("WORKSPACE_DISABLED: (workspace: string) => `Enable \${workspace}`", "WORKSPACE_TRASHED: (workspace: string) => `Restore \${workspace}`",
            "WORKSPACE_UNBOUND: (workspace: string) => `Bind \${workspace} to a runner`",
        ).forEach { assertTrue("coordinatorWorkspace.ts no longer says $it", workspace.contains(it)) }
        assertEquals("Restore x", ExceptionCards.fixLabel(ExceptionCards.CoordinatorCause.WORKSPACE_TRASHED, "x"))
        assertEquals("Bind x to a runner", ExceptionCards.fixLabel(ExceptionCards.CoordinatorCause.WORKSPACE_UNBOUND, "x"))
        assertNull(ExceptionCards.fixLabel(ExceptionCards.CoordinatorCause.RUNNER_DOWN, "x"))
    }
}
