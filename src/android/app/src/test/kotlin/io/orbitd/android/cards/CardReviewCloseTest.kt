package io.orbitd.android.cards

import androidx.compose.ui.test.*
import io.orbitd.android.composer.ComposerShell
import io.orbitd.android.composer.ComposerShellTest
import io.orbitd.android.core.cards.CardPreviews
import io.orbitd.android.core.net.ApiResponse
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CompletableDeferred
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.*
import org.junit.Test

/**
 * A review leaves on its own about 2 s after a press in it was recorded (the owner's call of 2026-11-02, iOS's
 * `ApprovalReviewCloseWiringTests`), on the production session page over the controlled server. The review's timer runs on the test
 * rule's clock, so the seconds are counted here, not waited for. Whatever no press of this review answered stays until it is closed.
 */
class CardReviewCloseTest : ComposerShellTest() {
    private val project = "34ReviewCloseProject01"
    private val approvals = "GET sessions/${ComposerShell.SESSION}/approvals"
    private val answerDoor = "POST projects/$project/open-items/q1/answer"
    private val asked = """{"question":"Ship the rollout?","options":[{"label":"Yes"},{"label":"Not yet"}],"recommendedOption":0}"""
    private val decided = ConcurrentHashMap.newKeySet<String>()
    /** Whether the read lists the coordinator's question as answered. */
    @Volatile private var readsAnswered = false

    private fun ok(body: String) = ApiResponse(200, body.encodeToByteArray())
    private fun refused(code: String) = ApiResponse(409, """{"statusCode":409,"code":"$code","message":"Refused"}""".encodeToByteArray())
    private fun decision(id: String) = "POST sessions/${ComposerShell.SESSION}/approvals/$id/decision"

    /** Plans waiting for the owner, each left out of the read once it is decided. */
    private fun plans(vararg ids: String) {
        ComposerShell.answers[approvals] = { ok(ids.filterNot { it in decided }.joinToString(",", "[", "]") { id ->
            """{"id":"$id","sessionId":"${ComposerShell.SESSION}","toolName":"ExitPlanMode","status":"PENDING","input":{"plan":"Ship $id."}}"""
        }) }
        ids.forEach { id -> ComposerShell.answers[decision(id)] = {
            decided += id; ok("""{"id":"$id","status":"ALLOWED","decidedAt":"2026-10-09T01:00:00.000Z"}""")
        } }
    }

    /** The conversation coordinates a project whose coordinator asks one question. The door's answer is the session's own. */
    private fun coordinatorAsks() {
        ComposerShell.session = mapOf("projectId" to JsonPrimitive(project))
        ComposerShell.answers["GET projects/$project"] = { ok("""{"id":"$project","title":"Review close"}""") }
        ComposerShell.answers["GET projects/$project/open-items"] = { ok(if (readsAnswered)
            """{"needsYou":[],"withCoordinator":[],"closedQuestions":[{"itemId":"q1","question":$asked,"askedAt":"2026-10-09T00:00:00.000Z",
                "resolution":"ANSWERED","resolvedBy":"USER","resolvedAt":"2026-10-09T00:30:00.000Z","answer":{"option":1,"text":null},
                "delivery":null,"withdrawReason":null}]}"""
            else """{"needsYou":[{"itemId":"q1","kind":"COORDINATOR_QUESTION","assignee":"OWNER","actions":["ANSWER"],
                "waitingSince":"2026-10-09T00:00:00.000Z","question":$asked}],"withCoordinator":[],"closedQuestions":[]}""") }
        ComposerShell.answers[answerDoor] = { ok(delivered) }
    }
    private val delivered = """{"itemId":"q1","delivery":{"sessionId":"${ComposerShell.SESSION}","turnId":"t1"}}"""
    private fun fresh() = app().realtime.state.value.session?.fresh == true

    private fun up() = has(hasTestTag("card-review"))
    /** The rule's clock moves on, and what it let run lands. */
    private fun advance(millis: Long) { compose.mainClock.advanceTimeBy(millis); compose.waitForIdle() }
    private fun openFromConversation(tag: String) {
        compose.onNodeWithTag("transcript-list").performScrollToNode(hasTestTag(tag))
        compose.onNodeWithTag(tag).performClick()
    }
    /** Opens a card's review and presses [verb] in it, once it can be pressed. */
    private fun press(card: String, verb: String) {
        openFromConversation("$card:preview")
        await { has(hasTestTag("$card:$verb") and isEnabled()) }
        compose.onNodeWithTag("$card:$verb").performClick()
    }
    private fun closeByHand() { compose.onNodeWithTag("card-review:close").performClick(); await { !up() } }

    @Test fun aPlanApprovedHereLeavesAMomentAfterItsRecord() {
        plans("plan1")
        signIn(); openSession()
        press("approval:plan1", "APPROVE_PLAN")
        await { has(hasTestTag("card-review:footer-line")) }
        compose.onNodeWithTag("card-review:title").assertTextEquals(CardPreviews.answeredTitle)
        advance(1_500)
        assertTrue("the record is up long enough to read", has(hasTestTag("card-review:footer-line")))
        advance(700)
        assertFalse("and then it leaves, with nobody closing it", up())
    }

    @Test fun closingByHandTakesTheTimerWithIt() {
        plans("plan1", "plan2")
        signIn(); openSession()
        press("approval:plan1", "APPROVE_PLAN")
        await { has(hasTestTag("card-review:footer-line")) }
        advance(1_000)
        closeByHand()
        openFromConversation("approval:plan2:preview")
        await { has(hasTestTag("approval:plan2:APPROVE_PLAN") and isEnabled()) }
        advance(3_000)
        assertTrue("the next review is not closed by a timer left behind", up())
    }

    @Test fun aRefusedAnswerStaysUntilClosed() {
        plans("plan1")
        ComposerShell.answers[decision("plan1")] = { refused("APPROVAL_NOT_PENDING") }
        signIn(); openSession()
        press("approval:plan1", "APPROVE_PLAN")
        await { has(hasTestTag("card-review:banner")) }
        advance(5_000)
        assertTrue("the refusal is read where it was pressed", has(hasTestTag("card-review:banner")))
        closeByHand()
    }

    @Test fun aRequestThatWentAwayStaysToSaySo() {
        plans("plan1")
        signIn(); openSession()
        openFromConversation("approval:plan1:preview")
        await { up() }
        // The Activity takes the copies of the cards this window saw with it, so nothing stands in for the one the server dropped.
        decided += "plan1"
        compose.activityRule.scenario.recreate()
        await { shows(CardPreviews.noLongerWaiting) }
        advance(5_000)
        assertTrue(shows(CardPreviews.noLongerWaiting))
    }

    @Test fun aCoordinatorsQuestionAnsweredHereLeavesAMomentAfterItsRecord() {
        coordinatorAsks()
        signIn(); openSession()
        press("item:q1", "OWNER_ANSWER")
        await { has(hasTestTag("item:q1:footer-line")) }
        assertFalse("this path never reaches RECORDED", has(hasTestTag("card-review:record")))
        advance(1_500)
        assertTrue("the record is up long enough to read", has(hasTestTag("item:q1:footer-line")))
        advance(700)
        assertFalse("and then it leaves, with nobody closing it", up())
    }

    /** Every re-read takes `fresh` away while it is out, and a coordinator's conversation is re-read as the answer reaches it. By then
     * the record is the read's, so the review goes on drawing it and the seconds run on: a busy conversation cannot hold it up. */
    @Test fun aReadInsideTheTwoSecondsDoesNotStartThemAgain() {
        coordinatorAsks()
        ComposerShell.answers[answerDoor] = { readsAnswered = true; ok(delivered) }
        signIn(); openSession()
        press("item:q1", "OWNER_ANSWER")
        await { has(hasTestTag("item:q1:footer-line")) }
        advance(1_000)
        val read = CompletableDeferred<Unit>()
        ComposerShell.gates["GET projects/$project/open-items"] = read
        app().realtime.refreshSession()
        await { !fresh() }
        advance(600)
        assertTrue("the record is still what it draws", has(hasTestTag("item:q1:footer-line")))
        read.complete(Unit)
        await { fresh() }
        advance(600)
        assertFalse(up())
    }

    /** The record reads the same whoever answered, and the press was this review's: only the door taking it counts. */
    @Test fun aQuestionAnotherEndAnsweredBeforeThePressStaysThoughItIsARecordNow() {
        coordinatorAsks()
        ComposerShell.answers[answerDoor] = { readsAnswered = true; refused("OPEN_ITEM_NOT_OPEN") }
        signIn(); openSession()
        press("item:q1", "OWNER_ANSWER")
        await { has(hasTestTag("item:q1:footer-line")) }
        advance(5_000)
        assertTrue(up())
    }

    @Test fun aQuestionAnsweredFromAnotherEndWhileItsReviewIsOpenStays() {
        coordinatorAsks()
        signIn(); openSession()
        openFromConversation("item:q1:preview")
        await { has(hasTestTag("item:q1:OWNER_ANSWER") and isEnabled()) }
        readsAnswered = true
        app().realtime.refreshSession()
        await { has(hasTestTag("item:q1:footer-line")) }
        advance(5_000)
        assertTrue(up())
    }

    @Test fun aRecordOpenedFromTheConversationStaysToBeRead() {
        readsAnswered = true
        coordinatorAsks()
        signIn(); openSession()
        await { has(hasTestTag("item:q1")) }
        openFromConversation("item:q1")
        await { has(hasTestTag("item:q1:footer-line")) }
        advance(5_000)
        assertTrue(up())
    }

    /** Answered here and closed by hand, it is a record like any other: the press belonged to the review that made it. */
    @Test fun aRecordOfAnAnswerGivenHereOpenedAgainStaysToBeRead() {
        coordinatorAsks()
        signIn(); openSession()
        press("item:q1", "OWNER_ANSWER")
        await { has(hasTestTag("item:q1:footer-line")) }
        closeByHand()
        openFromConversation("item:q1")
        await { has(hasTestTag("item:q1:footer-line")) }
        advance(5_000)
        assertTrue(up())
    }
}
