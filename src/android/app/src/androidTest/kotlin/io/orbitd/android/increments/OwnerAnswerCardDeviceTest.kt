package io.orbitd.android.increments

import androidx.compose.ui.test.*
import androidx.test.ext.junit.runners.AndroidJUnit4
import io.orbitd.android.core.cards.CoordinatorQuestions
import io.orbitd.android.core.cards.CoordinatorQueue
import io.orbitd.android.core.cards.OwnerAnswerLine
import io.orbitd.android.navigation.ObjectId
import okhttp3.mockwebserver.MockResponse
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The owner's answer handed to the coordinator as its question's own card (docs/mocks/owner-answer-sent-card, web 4d68b90ee), on a
 * device: one coordinator conversation of a project, served by the test's own fixture, whose open-items read holds the answered question
 * under its public id while the turn's card names it by its UUID. Each journey leaves the screenshot that is set beside the board's
 * built/ shot of the web: the one grey Answered card where the "Sent to the coordinator" line was (1-one-card, and 5-dark in the dark
 * theme), the card dashed while the turn waits on the queue (3-queued), and the words the coordinator was told in View details (4-details).
 */
@RunWith(AndroidJUnit4::class)
class OwnerAnswerCardDeviceTest : IncrementDeviceTest() {
    private val coord = "34OwnAnsSessionCoord01"
    private val project = "34OwnAnsProjectRelease"
    private val queuedTurn = "34OwnAnsTurnQueued0001"
    override val ids get() = listOf(workspace, runner, coord, project, queuedTurn)

    /** Whether the answer still waits on the queue behind the coordinator's running turn (3-queued). */
    @Volatile private var queued = false
    @Volatile private var theme = "light"

    private val item = "01a0d6a9-d763-70e1-b4cf-8793e971b511"
    private val recordKey = "item:${ObjectId.toPublic(item)}"
    private val askedAt = ago(40)
    private val answeredAt = ago(1)
    private val question = "Approve P1 rehearsing the compression-encoding switch on the dev table. I'm asking for P1: its task session " +
        "can't call ask_owner, and it has waited for approval since yesterday afternoon; the table hasn't been touched.\n\n" +
        "Table: `analytics.events_dev` (a dev table, 2.1 TiB, last written 09-20, no other writers). The original schema is archived.\n\n" +
        "Three steps, in order: ① apply → ② rollback (the same columns back to their original encoding) → ③ apply again. Read every " +
        "column back after each step, and watch for an hour after ③."
    private val told = "From Orbit · owner answer: you asked \"$question\". The owner answered: Approve all three ($answeredAt)."

    private fun detail() = """{"id":"$coord","title":"Coordinate the encoding switch","projectId":"$project",
        "status":"${if (queued) "RUNNING" else "AWAITING_INPUT"}","runState":"${if (queued) "RUNNING" else "AWAITING_INPUT"}","lifecycleState":"OPEN",
        "provider":"claude","engine":"claude","model":"claude-opus-5-5","assignedRunnerId":"$runner","agentId":"$workspace",
        "agent":{"id":"$workspace","name":"Alpha"},"createdAt":"${ago(600)}","lastTurnAt":"${ago(1)}","pendingApprovals":0,
        "lastAssistantText":"Reading what came in.","capabilities":{"canSend":true,"canComplete":true},"tags":[]}"""
    override fun sessions(view: String, project: String?) = if (view == "open") "[${detail()}]" else "[]"
    override fun userJson() = """{"id":"u1","email":"a15c@example.test","name":"A15c fixture","preferences":{"theme":"$theme"}}"""

    /** The question as the open-items read carries it once answered: under its public id, delivered to this coordinator. */
    private fun record() = """{"itemId":"${ObjectId.toPublic(item)}","question":{"question":${quote(question)},
        "options":[{"label":"Approve all three","description":"Run ① → ② → ③, reading every column back after each step."},
        {"label":"Approve ① only","description":"Apply first; decide on the rollback and the second apply after seeing the result."},
        {"label":"Hold off","description":"P1 keeps waiting; the table stays as it is."}],
        "recommendedOption":0,"blocksTaskIds":[],"ifUnanswered":null},"askedAt":"$askedAt","resolution":"ANSWERED","resolvedBy":"USER",
        "resolvedAt":"$answeredAt","answer":{"option":0,"text":null},"delivery":{"sessionId":"$coord","at":"$answeredAt"},"withdrawReason":null}"""
    private fun ownerAnswer() = """{"itemId":"$item","kind":"COORDINATOR_QUESTION","sessionId":"$coord","deliveredAt":"$answeredAt"}"""

    private fun events() = listOf(
        event(1, "user", """{"text":"Get P1's compression switch on the dev table approved and run."}""", ago(45), "t-1"),
        event(2, "assistant", """{"text":"P1 can't ask you itself, so I've sent its approval request to you."}""", ago(41), "t-1"),
        event(3, "assistant", """{"text":"The question is out; choose on its card. Until the answer comes back, I won't touch P1."}""", askedAt, "t-1"),
        event(4, "turn_end", """{"subtype":"success"}""", askedAt, "t-1"),
    ) + if (queued) listOf(
        event(5, "user", """{"text":"Check why P2's merge check failed."}""", ago(36), "t-2"),
        event(6, "assistant", """{"text":"I'm pulling P2's latest merge-check log first."}""", ago(35), "t-2"),
        event(7, "assistant", """{"text":"It's a time-zone case in the web suite, unrelated to P2's change; I'm reproducing it on main to be sure."}""",
            ago(2), "t-2"),
    ) else listOf(
        // The turn that handed the owner's answer to the coordinator.
        event(5, "user", """{"text":${quote(told)},"ownerAnswer":${ownerAnswer()}}""", answeredAt, "t-answer"),
        event(6, "assistant", """{"text":"Got it: approve all three. I've passed the approval to P1 and asked it to read every column back after each step."}""",
            answeredAt, "t-answer"),
        event(7, "turn_end", """{"subtype":"success"}""", answeredAt, "t-answer"),
    )

    /** The answer on the queue behind the running turn, as the listing carries a turn Orbit filed. */
    private fun turns() = if (!queued) "[]" else """[{"turnId":"$queuedTurn","kind":"message","placement":"queued","content":${quote(told)},
        "attachments":[],"ownerAnswer":${ownerAnswer()},"authoredByOrbit":true,"createdAt":"$answeredAt"}]"""

    override fun answer(req: Req): MockResponse? = when {
        req.path == "sessions/$coord" && req.method == "GET" -> json(detail())
        req.path == "sessions/$coord/events/page" -> json(page(events()))
        req.path == "sessions/$coord/turns" && req.method == "GET" -> json(turns())
        req.path == "tasks/evidence-decisions/pending" -> json("""{"decidingSessionId":"$coord","count":0,"oldestAgeSeconds":null,"pending":[],
            "waitingOnYou":[],"waitingOnCoordinator":[],"sentToCoordinator":[],"decided":[]}""")
        req.path == "projects/$project" -> json("""{"id":"$project","title":"Encoding switch","status":"OPEN","goal":"Switch the encoding.",
            "createdAt":"${ago(2000)}","startedAt":"${ago(1900)}","coordinatorSessionId":"$coord","_count":{"tasks":2},"acceptanceCriteriaItems":[]}""")
        req.path == "projects/$project/open-items" -> json("""{"needsYou":[],"withCoordinator":[],"closedQuestions":[${record()}]}""")
        req.path == "projects/$project/promotions/current" -> empty200()
        req.path == "projects/$project/promotions/merged" -> json("[]")
        req.path.startsWith("projects/$project/") -> json("{}")
        else -> null
    }

    private fun openConversation() {
        signIn()
        open("orbit-session:$coord")
        await("the coordinator conversation") { app.realtime.state.value.session?.fresh == true && exists(hasTestTag("transcript-list")) }
        await("the answered question's card") { exists(hasTestTag(recordKey), unmerged = true) }
    }

    private val line get() = CoordinatorQueue.sent

    /** The card is the turn's: inside its row, drawn once, and the rail under the transcript holds no second copy. */
    private fun verifyOneCardInTheTurnsPlace(turnTag: String) {
        verify("the Answered card is drawn in the turn's place", exists(hasTestTag(recordKey) and hasAnyAncestor(hasTestTag(turnTag)), unmerged = true))
        verify("its heading is Answered", textOf("$recordKey:heading") == CoordinatorQuestions.answeredHeading)
        verify("its answer is the option chosen", textOf("$recordKey:answer") == "Approve all three")
        verify("no line says it was sent", !exists(hasText(line, substring = true), unmerged = true))
        verify("the words are no bubble", !exists(hasText(told), unmerged = true))
        verify("the card is drawn once", count(hasTestTag(recordKey), unmerged = true) == 1)
        verify("the rail holds no second card", !exists(hasTestTag(recordKey) and hasAnyAncestor(hasTestTag("interaction-cards")), unmerged = true))
    }

    /** (1) One grey Answered card where the "Sent to the coordinator" line was. */
    @Test fun theAnswerIsItsQuestionsCardInTheTurnsPlace() = journey {
        openConversation()
        scrollTranscriptTo(hasTestTag("record:5:ownerAnswer"))
        verifyOneCardInTheTurnsPlace("record:5:ownerAnswer")
        verify("a delivered answer says nothing more", listOf("queued", "notice", "waiting").none { exists(hasTestTag("$recordKey:$it"), unmerged = true) })
        capture("1-one-card")
    }

    /** (2) Still on the queue behind the running turn: the card dashed, saying so, with no Cancel. */
    @Test fun aQueuedAnswerIsTheCardDashedWithNoCancel() = journey {
        queued = true
        openConversation()
        val turnTag = "queued:" + (ObjectId.canonical(queuedTurn) ?: queuedTurn)
        awaitTag(turnTag)
        scrollTranscriptTo(hasTestTag(turnTag))
        verifyOneCardInTheTurnsPlace(turnTag)
        verify("it says it is queued", textOf("$recordKey:queued") == CoordinatorQuestions.queuedForCoordinator)
        verify("the queue's Cancel is gone", !exists(hasTestTag("queued-foot"), unmerged = true) && !says(turnTag, "Cancel"))
        capture("3-queued")
    }

    /** (3) View details: the question replayed, and the words the coordinator was told folded at the foot of the replay. */
    @Test fun viewDetailsHoldsWhatTheCoordinatorWasTold() = journey {
        openConversation()
        scrollTranscriptTo(hasTestTag("record:5:ownerAnswer"))
        compose.onNodeWithTag(recordKey).performClick()
        await("the card's review") { exists(hasTestTag("card-review")) && exists(hasTestTag("$recordKey:told"), unmerged = true) }
        verify("the review is the record's", textOf("card-review:title") == CoordinatorQuestions.answeredHeading)
        verify("the words are folded", !exists(hasTestTag("$recordKey:told:words"), unmerged = true))
        compose.onNode(hasText(OwnerAnswerLine.told) and hasClickAction()).performScrollTo().performClick()
        await("the words the coordinator was told") { exists(hasTestTag("$recordKey:told:words"), unmerged = true) }
        verify("they are the turn's, verbatim", textOf("$recordKey:told:words") == told)
        compose.onNodeWithTag("$recordKey:told:words", useUnmergedTree = true).performScrollTo()
        capture("4-details")
    }

    /** (1) in the dark theme. */
    @Test fun theAnswerIsItsQuestionsCardInTheDark() = journey {
        theme = "dark"
        openConversation()
        scrollTranscriptTo(hasTestTag("record:5:ownerAnswer"))
        verifyOneCardInTheTurnsPlace("record:5:ownerAnswer")
        capture("5-dark")
    }
}
