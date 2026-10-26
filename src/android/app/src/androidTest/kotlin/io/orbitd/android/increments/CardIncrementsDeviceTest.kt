package io.orbitd.android.increments

import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.*
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.orbitd.android.core.cards.CoordinatorQuestions
import io.orbitd.android.core.cards.CoordinatorQueue
import io.orbitd.android.core.cards.OwnerAnswerLine
import io.orbitd.android.core.cards.OwnerReview
import io.orbitd.android.watch.WatchProjection
import java.time.Instant
import java.time.ZoneId
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import okhttp3.mockwebserver.MockResponse
import org.junit.Test
import org.junit.runner.RunWith

/**
 * A08 increments and B19 on a device: one coordinator conversation of an Automatic project, served by the test's own fixture, carrying
 * what the rows draw — an open coordinator question written in Markdown (A08-12), two ended questions (A08-13), a watch's wake
 * (A08-14), one revision waiting for the paused coordinator and one already sent to it (A08-16), the owner's answer handed to the
 * coordinator (A08-19), the session-request, reply, delivery and source cards (B19), and a watch over a running child session and a
 * task whose run session it also lists (A08-20, the running pill's spinner, the cards without footer links).
 */
@RunWith(AndroidJUnit4::class)
class CardIncrementsDeviceTest : IncrementDeviceTest() {
    private val coord = "34A15cSessionCoord0001"
    private val project = "34A15cProjectRelease01"
    private val sender = "34A15cSessionSender001"
    private val child = "34A15cSessionChild0009"
    private val run = "34A15cSessionTaskRun01"
    private val landing = "34A15cSessionLanding01"
    private val task = "34A15cTaskShipIt000001"
    private val waitingTask = "34A15cTaskWaiting00001"
    private val sentTask = "34A15cTaskSentToCoord1"
    private val startedTask = "34A15cTaskStarted00001"
    private val watch = "34A15cWatchStripW00001"
    private val request = "34A15cSessionRequest01"
    override val ids get() = listOf(workspace, runner, coord, project, sender, child, run, landing, task, waitingTask, sentTask, startedTask, watch, request)

    /** The coordinator's run failed on Claude's weekly limit, so revisions wait for it (A08-16). */
    @Volatile private var paused = false
    /** Whether the Markdown question is open (A08-12); A08-16 leaves it out, so nothing else asks for the owner. */
    @Volatile private var openQuestion = true
    private val retryAt: String = ZonedDateTime.now(ZoneId.of("Asia/Shanghai")).plusDays(2).withHour(19).withMinute(0).withSecond(0).withNano(0)
        .toInstant().toString()
    private val quota = "You've hit your weekly limit · resets ${DateTimeFormatter.ofPattern("MMM d", Locale.US)
        .format(Instant.parse(retryAt).atZone(ZoneId.of("Asia/Shanghai")))}, 7pm (Asia/Shanghai)"

    private fun detail() = """{"id":"$coord","title":"Coordinate the release","projectId":"$project",
        "status":"${if (paused) "FAILED" else "AWAITING_INPUT"}","runState":"${if (paused) "FAILED" else "AWAITING_INPUT"}","lifecycleState":"OPEN",
        "agentId":"$workspace","agent":{"id":"$workspace","name":"Alpha"},"assignedRunnerId":"$runner","provider":"claude","model":"claude-opus-5-5",
        "createdAt":"${ago(600)}","lastTurnAt":"${ago(4)}","pendingApprovals":0,
        ${if (paused) "\"error\":${quote(quota)},\"retryAt\":\"$retryAt\"," else ""}"lastAssistantText":${quote(if (paused) quota else "Reading what came in.")},
        "capabilities":{"canSend":true,"canComplete":true},"tags":[]}"""
    private fun senderDetail() = """{"id":"$sender","title":"Release checklist","status":"AWAITING_INPUT","runState":"AWAITING_INPUT","lifecycleState":"OPEN",
        "agentId":"$workspace","agent":{"id":"$workspace","name":"Alpha"},"createdAt":"${ago(900)}","lastTurnAt":"${ago(20)}","pendingApprovals":0,
        "capabilities":{"canSend":true,"canComplete":true},"tags":[]}"""
    override fun sessions(view: String, project: String?) = if (view == "open") "[${detail()},${senderDetail()}]" else "[]"

    // ---- What the conversation carries. ----

    private val markdownQuestion = "Ship **the rollout** now?\n\n- maintenance resumed\n- `v2` tagged\n\nSee [the plan](https://example.test/plan)."
    private val questionMd = """{"itemId":"q-md","kind":"COORDINATOR_QUESTION","title":"Coordinator Question","detailLine":"A decision is needed.",
        "assignee":"OWNER","assigneeReason":"DEFAULT","waitingSince":"${ago(12)}","escalateAt":null,"escalatedAt":null,"taskId":null,"sessionId":null,
        "promotionId":null,"fuseEpisodeId":null,"delivery":{"state":"DELIVERED","sessionId":"$coord","at":"${ago(12)}"},"actions":["ANSWER"],
        "question":{"question":${quote(markdownQuestion)},"options":[{"label":"Ship now","description":"Tag and roll out today."},
        {"label":"Wait a day"}],"recommendedOption":0,"blocksTaskIds":[],"ifUnanswered":"The rollout waits."},
        "startRequest":null,"facts":null,"handling":null,"outcome":null}"""
    private val recordQuestion = """{"question":"The rollback's follow-ups are done:\n\n- maintenance resumed\n- **all three fixes** shipped\n\nApprove reopening the rollout.",
        "options":[{"label":"Reopen now","description":"No special timing."},{"label":"Switch at the next round"}],"recommendedOption":0}"""
    private val answered = """{"itemId":"q-answered","question":$recordQuestion,"askedAt":"${ago(40)}","resolution":"ANSWERED","resolvedBy":"USER",
        "resolvedAt":"${ago(30)}","answer":{"option":1,"text":" After 22:00. "},"delivery":null,"withdrawReason":null}"""
    private val withdrawn = """{"itemId":"q-withdrawn","question":{"question":"Hold the release notes until the Android build is checked?","options":[]},
        "askedAt":"${ago(50)}","resolution":"WITHDRAWN","resolvedBy":"COORDINATOR","resolvedAt":"${ago(45)}","answer":null,"delivery":null,
        "withdrawReason":"Not needed after the rollback."}"""
    private fun openItems() = """{"needsYou":[${if (openQuestion) questionMd else ""}],"withCoordinator":[],"closedQuestions":[$answered,$withdrawn]}"""

    private fun evidence(id: String, title: String) = """{"taskId":"$id","title":${quote(title)},"status":"IN_PROGRESS","projectId":"$project","ownerCard":null,
        "criterion":{"key":"notes","text":"The release notes list every change merged since 0.1.229."},"evidenceRevision":"1","submittedAt":"${ago(4)}",
        "ageSeconds":240,"claim":"Every change merged since 0.1.229 is listed under its area.","gaps":["The Android section was not checked on a device."],
        "citations":[],"decidability":{"decidable":true,"refusal":null,"requiredAction":null},
        "independence":{"independent":true,"disqualification":null,"requiredAction":null}}"""
    private val sentAt = ago(90)
    private fun queue() = """{"decidingSessionId":"$coord","count":0,"oldestAgeSeconds":null,"pending":[],"waitingOnYou":[],
        "waitingOnCoordinator":[${evidence(waitingTask, "Release notes for 0.1.230")}],
        "sentToCoordinator":[{"taskId":"$sentTask","title":"Changelog links","projectId":"$project","evidenceRevision":"1","deliveredAt":"$sentAt"}],
        "decided":[]}"""

    private val wakeWatch = "0199a8f0-1111-7aaa-8bbb-0000a15cbeef"
    private val wakeTask = "0199a8f0-2222-7aaa-8bbb-00000000c0de"
    private val wakeText = "Orbit Watch $wakeWatch matched at generation 2: ALL TASK_TERMINAL 1/1\nThis turn was queued by the watch, not typed by a person.\n" +
        "```json\n{\"watchId\":\"$wakeWatch\",\"changedTargets\":[{\"kind\":\"TASK\",\"id\":\"$wakeTask\",\"state\":\"SATISFIED\",\"observed\":{\"status\":\"DONE\"}}]}\n```"
    private val toldWords = "From Orbit · owner answer: you asked \"Merge now, or wait for the review?\". The owner answered: Wait for the review (${ago(3)})."
    private val answeredAt = ago(3)

    private fun events() = listOf(
        event(1, "user", """{"text":"Keep the release moving, and decide each task’s evidence as it comes in."}"""),
        event(2, "assistant", """{"text":"I will keep the release moving."}"""),
        // B19: a message another session sent here, a reply that came back, a task this conversation started, a delivered item, the start.
        event(3, "user", """{"text":"Message from Release checklist","sessionMessage":{"requestId":"$request","fromSessionId":"$sender",
            "fromTitle":"Release checklist","requestPreview":"Can you confirm the tag?"}}"""),
        event(4, "user", """{"text":"Reply from Release checklist","sessionReplies":[{"requestId":"$request","fromSessionId":"$sender",
            "fromTitle":"Release checklist","outcome":"REPLIED","replyText":"Tagged v0.1.230."}]}"""),
        event(5, "user", """{"text":"Task started","taskStart":{"taskId":"$startedTask","title":"Wire the checks"}}"""),
        event(6, "user", """{"text":"Item delivered","openItemDelivery":{"itemId":"item-d1","kind":"TASK_FAILED","title":"Wire the checks failed",
            "task":{"id":"$startedTask","title":"Wire the checks","sessionId":"$run"},"landingSessionId":"$landing"}}"""),
        event(7, "user", """{"text":"Project started","projectStarted":{"projectId":"$project","projectTitle":"Release 0.1.230","by":"OWNER"}}"""),
        // A08-14: a turn a watch queued.
        event(8, "user", """{"text":${quote(wakeText)}}"""),
        // A08-19: the owner's answer handed to the coordinator.
        event(9, "user", """{"text":${quote(toldWords)},"ownerAnswer":{"itemId":"q-earlier","kind":"COORDINATOR_QUESTION","sessionId":"$coord",
            "deliveredAt":"$answeredAt"}}""", turnId = "turn-answer"),
        event(10, "assistant", """{"text":"Waiting for the review, as you answered."}"""),
    )

    /** A watch this conversation keeps over a running child session, a task, and the task's run session (A08-20). */
    private fun watches() = """[{"id":"$watch","observerType":"SESSION","observerSessionId":"$coord","predicateVersion":1,
        "predicate":{"kind":"ANY_OF","operands":[{"kind":"ALL","over":"ALL_TARGETS","leaf":"SESSION_TURN_SETTLED"},{"kind":"ALL","over":"ALL_TARGETS","leaf":"TASK_TERMINAL"}]},
        "mode":"ONE_SHOT","action":"RESUME_SESSION","state":"ACTIVE","generation":0,"expiresAt":"${Instant.now().plusSeconds(3600)}","nextEvaluateAt":null,
        "lastEvaluatedAt":"${Instant.now().minusSeconds(20)}","idempotencyKey":null,"createdAt":"${ago(10)}","updatedAt":"${ago(10)}",
        "targets":[
          {"targetKind":"SESSION","targetResourceId":"$child","state":"OBSERVED","targetEpoch":0,"lastEvaluatedAt":null,"targetTitle":"Deploy main",
           "targetStatus":{"status":"RUNNING","running":true,"queued":false},"targetTask":null},
          {"targetKind":"SESSION","targetResourceId":"$run","state":"OBSERVED","targetEpoch":0,"lastEvaluatedAt":null,"targetTitle":"Task: Ship it",
           "targetStatus":{"status":"AWAITING_INPUT","running":false,"queued":false},
           "targetTask":{"id":"$task","title":"Ship it","status":{"status":"IN_PROGRESS","running":false,"queued":false}}},
          {"targetKind":"TASK","targetResourceId":"$task","state":"OBSERVED","targetEpoch":0,"lastEvaluatedAt":null,"targetTitle":"Ship it",
           "targetStatus":{"status":"IN_PROGRESS","running":false,"queued":false}}],
        "matches":[],"expiryDeliveries":[]}]"""
    private fun created() = """{"total":1,"running":0,"failed":0,"done":0,"items":[{"id":"$startedTask","title":"Wire the checks","status":"OPEN",
        "running":false,"queued":false,"createdAt":"${ago(25)}"}]}"""

    override fun answer(req: Req): MockResponse? = when {
        req.path == "sessions/$coord" && req.method == "GET" -> json(detail())
        req.path == "sessions/$coord/events/page" -> json(page(events()))
        req.path == "sessions/$coord/created-tasks" -> json(created())
        req.path == "sessions/$sender" && req.method == "GET" -> json(senderDetail())
        req.path == "sessions/$sender/events/page" -> json(page(listOf(event(1, "user", """{"text":"Can you confirm the tag?"}"""),
            event(2, "assistant", """{"text":"Asking the coordinator."}"""))))
        req.path == "session-requests/$request" -> json("""{"id":"$request","state":"REPLIED","replyText":"Tagged v0.1.230.","replyBy":"$sender"}""")
        req.path == "tasks/evidence-decisions/pending" -> json(queue())
        req.path == "projects/$project" -> json("""{"id":"$project","title":"Release 0.1.230","status":"OPEN","goal":"Ship 0.1.230.",
            "createdAt":"${ago(2000)}","startedAt":"${ago(1900)}","coordinatorSessionId":"$coord","_count":{"tasks":4},"acceptanceCriteriaItems":[]}""")
        req.path == "projects/$project/open-items" -> json(openItems())
        req.path == "projects/$project/promotions/current" -> empty200()
        req.path == "projects/$project/promotions/merged" -> json("[]")
        req.path.startsWith("projects/$project/") -> json("{}")
        req.path == "watches" -> json(watches())
        else -> null
    }

    private fun openConversation() {
        signIn()
        open("orbit-session:$coord")
        await("the coordinator conversation") { app.realtime.state.value.session?.fresh == true && exists(hasTestTag("transcript-list")) }
    }

    /** A08-12: the question's body is drawn as Markdown — bold, a list, code and a link — in its review; its preview is plain words. */
    @Test fun coordinatorQuestionBodyIsMarkdown() = journey {
        openConversation()
        scrollTranscriptTo(hasTestTag("item:q-md"))
        capture("01-question-preview")
        // The compact preview's summary is the question's own words, as iOS's ApprovalReviewLayout draws them (`Text(summary)` of a
        // String, verbatim); the Markdown is the card's body, in its review.
        note("the preview's summary is drawn verbatim: " + compose.onAllNodes(hasAnyAncestor(hasTestTag("item:q-md:preview")), useUnmergedTree = true)
            .fetchSemanticsNodes().mapNotNull { it.config.getOrNull(SemanticsProperties.Text)?.joinToString("") { t -> t.text } }.joinToString(" | "))
        if (exists(hasTestTag("item:q-md:preview"))) compose.onNodeWithTag("item:q-md:preview").performScrollTo().performClick()
        await("the question's review") { exists(hasTestTag("card-review")) }
        val inReview = hasAnyAncestor(hasTestTag("card-review"))
        await("the bold paragraph") { exists(inReview and hasText("Ship the rollout now?"), unmerged = true) }
        val paragraph = compose.onAllNodes(inReview and hasText("Ship the rollout now?"), useUnmergedTree = true).fetchSemanticsNodes().first()
            .config[SemanticsProperties.Text].first()
        val bold = paragraph.spanStyles.any { it.item.fontWeight == FontWeight.Bold && paragraph.text.substring(it.start, it.end) == "the rollout" }
        verify("“the rollout” is bold and its marks are gone", bold)
        verify("the list is drawn as bullets", count(inReview and hasText("• "), unmerged = true) >= 2 &&
            exists(inReview and hasText("maintenance resumed"), unmerged = true))
        val code = compose.onAllNodes(inReview and hasText("v2 tagged"), useUnmergedTree = true).fetchSemanticsNodes().firstOrNull()
            ?.config?.getOrNull(SemanticsProperties.Text)?.firstOrNull()
        verify("`v2` is drawn as code", code != null && code.spanStyles.any { it.item.fontFamily == FontFamily.Monospace && code.text.substring(it.start, it.end) == "v2" })
        val link = compose.onAllNodes(inReview and hasText("See the plan."), useUnmergedTree = true).fetchSemanticsNodes().firstOrNull()
            ?.config?.getOrNull(SemanticsProperties.Text)?.firstOrNull()
        verify("“the plan” is a link", link != null && (link.getLinkAnnotations(0, link.length).isNotEmpty() ||
            link.getStringAnnotations(0, link.length).isNotEmpty()))
        verify("no Markdown marks are left in the review",
            compose.onAllNodes(inReview and hasText("**", substring = true), useUnmergedTree = true).fetchSemanticsNodes().isEmpty() &&
            compose.onAllNodes(inReview and hasText("](", substring = true), useUnmergedTree = true).fetchSemanticsNodes().isEmpty())
        capture("02-question-review-markdown")
    }

    /** A08-13: an answered and a withdrawn question stay as records where their cards were; View details replays the answer. */
    @Test fun endedCoordinatorQuestionsAreKeptAsRecords() = journey {
        openConversation()
        val record = Json.parseToJsonElement(answered).jsonObject
        val gone = Json.parseToJsonElement(withdrawn).jsonObject
        scrollTranscriptTo(hasTestTag("item:q-answered"))
        verify("the answered record's heading", textOf("item:q-answered:heading") == CoordinatorQuestions.answeredHeading)
        verify("its answer is the option chosen", textOf("item:q-answered:answer") == "Switch at the next round")
        verify("its note is quoted", textOf("item:q-answered:note") == "“After 22:00.”")
        verify("it waits for the next coordinator", textOf("item:q-answered:waiting") == CoordinatorQuestions.waitingForCoordinator)
        verify("its lead is the question in plain words", textOf("item:q-answered:lead") ==
            "The rollback's follow-ups are done: maintenance resumed all three fixes shipped Approve reopening the rollout.")
        capture("01-answered-record")
        scrollTranscriptTo(hasTestTag("item:q-withdrawn"))
        verify("the withdrawn record's heading", textOf("item:q-withdrawn:heading") == CoordinatorQuestions.withdrawnHeading)
        verify("who withdrew it", textOf("item:q-withdrawn:withdrew") == CoordinatorQuestions.withdrewLine(gone))
        verify("and why", textOf("item:q-withdrawn:reason") == "“Not needed after the rollback.”")
        capture("02-withdrawn-record")
        scrollTranscriptTo(hasTestTag("item:q-answered"))
        compose.onNodeWithTag("item:q-answered").performClick()
        await("the answered record's replay") { exists(hasTestTag("item:q-answered:footer-line"), unmerged = true) }
        verify("the replay ticks the option chosen", exists(hasTestTag("item:q-answered:option:1:chosen"), unmerged = true) &&
            !exists(hasTestTag("item:q-answered:option:0:chosen"), unmerged = true))
        verify("the replay's footer says who ended it", textOf("item:q-answered:footer-line") == CoordinatorQuestions.footerLine(record))
        verify("and where the answer went", textOf("item:q-answered:footer-detail") == CoordinatorQuestions.waitingForCoordinator)
        capture("03-answered-replay")
    }

    /** A08-14: a turn a watch queued is one event line that opens to its details. */
    @Test fun watchWakeIsOneEventLineWithDetails() = journey {
        openConversation()
        scrollTranscriptTo(hasTestTag("watch-wake:line"))
        verify("the line says the watch triggered", says("watch-wake:line", "Watch triggered"))
        verify("the target is named by its id's last eight", compose.onAllNodesWithTag("watch-wake:name", useUnmergedTree = true)
            .fetchSemanticsNodes().first().config[SemanticsProperties.Text].joinToString("") { it.text } == "Task ${wakeTask.takeLast(8)}")
        verify("and how it came out", compose.onAllNodesWithTag("watch-wake:status", useUnmergedTree = true)
            .fetchSemanticsNodes().first().config[SemanticsProperties.Text].joinToString("") { it.text } == "DONE")
        verify("the person's bubble is not drawn", !exists(hasText("This turn was queued by the watch", substring = true), unmerged = true))
        capture("01-wake-line")
        compose.onNodeWithTag("watch-wake:line").performClick()
        await("the wake's details") { exists(hasTestTag("watch-wake:why"), unmerged = true) }
        verify("why it woke", textOf("watch-wake:why") == "1 of 1 finished")
        verify("what it was queued by", textOf("watch-wake:meta") == "Queued by a watch, not typed by you · generation 2")
        verify("View watch is offered", exists(hasTestTag("watch-wake:view-watch"), unmerged = true))
        capture("02-wake-details")
    }

    /** A08-16: a revision waiting for the paused coordinator is a card that asks nothing until Decide it myself; one already sent to it
     * is a line. */
    @Test fun evidenceWaitingOnAPausedCoordinatorFoldsToAWaitingCard() = journey {
        paused = true
        openQuestion = false
        openConversation()
        val key = "evidence:$waitingTask:1"
        scrollTranscriptTo(hasTestTag(key))
        verify("the card is titled for the coordinator", says(key, CoordinatorQueue.title))
        verify("it says why it waits", textOf("$key:paused") ==
            "Coordinator paused · weekly limit · resets ${OwnerReview.receiptTime(retryAt)}")
        verify("and that the owner may still decide", textOf("$key:note") == CoordinatorQueue.explanation)
        verify("it asks nothing yet", !exists(hasTestTag("$key:CONFIRM_EVIDENCE")) && !exists(hasTestTag("$key:SEND_BACK")))
        verify("the sent revision is one line", textOf("evidence:$sentTask:1").ifEmpty {
            compose.onAllNodes(hasAnyAncestor(hasTestTag("evidence:$sentTask:1")), useUnmergedTree = true).fetchSemanticsNodes()
                .mapNotNull { it.config.getOrNull(SemanticsProperties.Text)?.joinToString("") { t -> t.text } }.joinToString("")
        } == CoordinatorQueue.sentLine(OwnerReview.receiptTime(sentAt)))
        verify("nothing waiting for the coordinator is counted", !exists(hasTestTag("needs-you-bar")))
        capture("01-waiting-card")
        compose.onNodeWithTag("$key:DECIDE_MYSELF").performScrollTo().performClick()
        await("today's evidence card in place") { exists(hasTestTag("$key:CONFIRM_EVIDENCE")) }
        verify("deciding here is the owner's choice", textOf("$key:note") == CoordinatorQueue.decideHere)
        compose.onNodeWithTag("$key:SEND_BACK").performScrollTo()
        capture("02-decide-it-myself")
    }

    /** A08-19: the owner's answer handed to the coordinator is one grey line that opens to the words the agent read. */
    @Test fun ownersAnswerToTheCoordinatorIsOneLine() = journey {
        openConversation()
        val line = CoordinatorQueue.sentLine(OwnerReview.receiptTime(answeredAt))
        scrollTranscriptTo(hasTestTag("record:9:ownerAnswer"))
        verify("the answer is the line “$line”", says("record:9:ownerAnswer", line))
        verify("its words are not a bubble", !exists(hasText(toldWords), unmerged = true))
        capture("01-owner-answer-line")
        compose.onNode(hasText(line) and hasAnyAncestor(hasTestTag("record:9:ownerAnswer")), useUnmergedTree = true).performClick()
        await("what the coordinator was told") { exists(hasTestTag("record:9:ownerAnswer:told")) }
        verify("the dialog is headed “${OwnerAnswerLine.told}”", says("record:9:ownerAnswer:told", OwnerAnswerLine.told))
        verify("and holds the words verbatim", says("record:9:ownerAnswer:told", toldWords))
        capture("02-owner-answer-told")
    }

    /** B19: the session-request, reply, task-start, delivery and project-start cards, and the sender's door. */
    @Test fun sessionRequestReplyDeliveryAndSourceCards() = journey {
        openConversation()
        scrollTranscriptTo(hasText("Message from another session"))
        verify("the request card", exists(hasText("Message from another session")) && exists(hasText("Can you confirm the tag?"), unmerged = true))
        await("the request's state read from the server") { calls.any { it == "GET session-requests/$request" } }
        await("the request's state drawn") { exists(hasText("REPLIED"), unmerged = true) }
        verify("the recipient answers it", exists(hasText("The recipient session answers this request."), unmerged = true))
        capture("01-session-request")
        scrollTranscriptTo(hasText("Session reply · REPLIED"))
        verify("the reply card says what came back", exists(hasText("Tagged v0.1.230."), unmerged = true))
        capture("02-session-reply")
        scrollTranscriptTo(hasText("Task started"))
        verify("the task-start card names the task", exists(hasText("Wire the checks"), unmerged = true))
        scrollTranscriptTo(hasText("Project item delivered"))
        verify("the delivery's two doors", exists(hasText("Open the failed session ↗"), unmerged = true) && exists(hasText("Open the landing ↗"), unmerged = true))
        capture("03-delivery")
        scrollTranscriptTo(hasText("Project started"))
        verify("the project-start card", exists(hasText("Release 0.1.230"), unmerged = true))
        capture("04-project-started")
        scrollTranscriptTo(hasText("Message from another session"))
        compose.onAllNodes(hasText("Open sender session") and hasClickAction()).onFirst().performScrollTo().performClick()
        await("the sender's session opens") { app.realtime.state.value.session?.id?.let { io.orbitd.android.navigation.ObjectId.same(it, sender) } == true }
        awaitText("Asking the coordinator.")
        capture("05-sender-session")
    }

    /** A08-20, the running pill's spinner (A01b I-PILL-SPINNER) and the cards' missing footers (A01b I-CARD-FOOTERS). */
    @Test fun watchingCardFoldsARunSessionIntoItsTaskAndSpinsForARunningSession() = journey {
        openConversation()
        await("the Watching card") { exists(hasTestTag("watch-strip-line")) }
        capture("01-watching-line")
        compose.onNodeWithTag("watch-strip-line").performClick()
        awaitTag("watch-strip-target:$watch:$task")
        verify("the running child session is listed", exists(hasTestTag("watch-strip-target:$watch:$child")))
        verify("the task's run session folds into the task's row", !exists(hasTestTag("watch-strip-target:$watch:$run")))
        verify("the task row is the task's, by its title", says("watch-strip-target:$watch:$task", "Ship it"))
        verify("the running session's pill spins", exists(hasTestTag("pill-spinner") and hasAnyAncestor(hasTestTag("watch-strip-target:$watch:$child")), unmerged = true))
        verify("the Watching card has no footer links", listOf(WatchProjection.STRIP_MANAGE, WatchProjection.STRIP_OPEN_TASK, WatchProjection.STRIP_OPEN_SESSION)
            .none { exists(hasText(it), unmerged = true) })
        capture("02-watching-open")
        if (exists(hasTestTag("session-tasks"))) {
            compose.onNodeWithTag("session-tasks:line").performClick()
            await("the Tasks card's list") { exists(hasTestTag("session-tasks:list")) }
            verify("the Tasks card has no footer link", compose.onAllNodes(hasAnyAncestor(hasTestTag("session-tasks")) and hasText("›", substring = true),
                useUnmergedTree = true).fetchSemanticsNodes().isEmpty())
            capture("03-tasks-open")
        } else note("no Tasks card drawn for this conversation")
    }
}
