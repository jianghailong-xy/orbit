package io.orbitd.android.core.cards

import io.orbitd.android.core.protocol.Wire
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset

/**
 * A08-1 (iOS b573f499b): the owner-confirmation card's review — held, case for case, to the fixture the web and the Apple
 * clients are proved against (`owner-confirmation-review.fixture.json`, OrbitKit OwnerConfirmationReviewTests): what the bar
 * draws, how a window is said, what a press sends, and what a receipt lists.
 */
class OwnerReviewTest {
    private val corpus = fixture("owner-confirmation-review.fixture.json")
    /** The fixture's clock: the instant's UTC hours and minutes. */
    private val utc: (String) -> String? = { iso ->
        runCatching { Instant.parse(iso).atOffset(ZoneOffset.UTC).let { "%02d:%02d".format(it.hour, it.minute) } }.getOrNull()
    }

    @Test fun theBarDrawsWhatTheFixtureDraws() {
        val bars = corpus.objects("bars")
        assertTrue(bars.size >= 16)
        bars.forEach { case ->
            val review = assertNotNullReview(case["review"], case.text("case")!!)
            assertEquals(case.text("case"), case.obj("bar"), OwnerReview.bar(review, OwnerReview.Place.valueOf(case.text("place")!!), utc).json())
        }
    }

    @Test fun aWindowIsSaidTheWayTheFixtureSaysIt() {
        corpus.objects("windows").forEach { case ->
            assertEquals("${case.number("seconds")}", case.text("words"), OwnerReview.windowWords(case.number("seconds")!!))
        }
    }

    /** The waiting request the fixture's presses answer: `req-1`, its review, the choices made on the card. */
    private fun card(case: JsonObject) = InteractionCard("owner:t1:${case.text("requestId")}", CardFamily.OWNER_CONFIRMATION,
        OwnerReview.heading, buildJsonObject {
            put("taskId", "t1"); put("status", "IN_PROGRESS"); put("completionCriterion", "OWNER_CONFIRMED")
            putJsonObject("waiting") {
                put("requestId", case.text("requestId")); put("sessionId", "s"); put("requestedAt", "2026-10-02T14:55:00Z")
                put("review", case["review"] ?: JsonNull)
            }
        }, "s", objectId = "t1", binding = "b", actions = listOf(CardVerb.CONFIRM_OWNER, CardVerb.SEND_BACK))
    private fun choices(case: JsonObject): List<OwnerAnswer> = case.obj("choices")!!.map { (key, value) ->
        if (value is JsonPrimitive) OwnerAnswer(key, value.int) else OwnerAnswer(key, text = (value as JsonObject).text("other"))
    }

    @Test fun thePressSendsWhatTheFixtureSends() {
        corpus.objects("requests").forEach { case ->
            val name = case.text("case")!!
            val card = card(case)
            val review = OwnerReview.readable(case["review"])
            assertEquals(name, case.flag("complete"), OwnerReview.complete(review, choices(case)))
            val expected = case.obj("body")!!
            if (case.text("decision") == "SEND_BACK") {
                val sent = CardRequests.build(card, CardVerb.SEND_BACK, CardInput(text = expected.text("note")!!))
                assertEquals(name, expected, Wire.json.parseToJsonElement(sent.body!!.decodeToString()))
                assertEquals(listOf("tasks", "t1", "owner-confirmation"), sent.path)
            } else if (case.flag("complete")) {
                val sent = CardRequests.build(card, CardVerb.CONFIRM_OWNER, CardInput(ownerAnswers = choices(case)))
                assertEquals(name, expected, Wire.json.parseToJsonElement(sent.body!!.decodeToString()))
            } else {
                // Confirm done waits while an Other has no words; what it would say is still the fixture's.
                assertThrows(name, IllegalArgumentException::class.java) {
                    CardRequests.build(card, CardVerb.CONFIRM_OWNER, CardInput(ownerAnswers = choices(case)))
                }
                val (record, answers) = OwnerReview.answered(review, choices(case))
                assertEquals(name, expected["reviewRecordId"], record)
                assertEquals(name, expected["answers"], JsonArray(answers))
            }
        }
    }

    @Test fun theReceiptListsTheAnswersTheFixtureLists() {
        corpus.objects("answers").forEach { case ->
            val decided = case.obj("decided")!!
            val lines = case.objects("lines").map { it.text("text")!! to it.flag("notShown") }
            assertEquals(case.text("case"), lines, OwnerReview.answerLines(decided))
            assertEquals(case.text("case"), case.flag("before"), OwnerReview.cameInAfter(decided))
        }
    }

    /** A review this build cannot read costs the bar, never the card; a reason it does not know says the second half alone. */
    @Test fun aReviewThisBuildCannotReadCostsOnlyTheReview() {
        val review = corpus.objects("bars").first().obj("review")!!
        assertNull(OwnerReview.readable(JsonObject(review + ("state" to JsonPrimitive("SOMETHING_NEW")))))
        assertNull(OwnerReview.readable(JsonObject(review - "dueAt")))
        assertNotNull(OwnerReview.readable(review))
        assertEquals("Only the agent that did the work has checked this.", OwnerReview.notReviewedNote("SOMETHING_NEW", 1800))
        assertEquals("Only the agent that did the work has checked this.", OwnerReview.notReviewedNote(null, 1800))
    }

    @Test fun receiptTimesAreAFixedClockAndADayWhenItIsAnotherDay() {
        val zone = ZoneId.of("Asia/Shanghai")
        val now = Instant.parse("2026-10-09T02:00:00Z")
        assertEquals("08:05", OwnerReview.receiptTime("2026-10-09T00:05:00Z", now, zone))
        assertEquals("9/15 08:05", OwnerReview.receiptTime("2026-09-15T00:05:00.000Z", now, zone))
        assertNull(OwnerReview.receiptTime("not a time", now, zone))
    }

    @Test fun theDoorsStaleRefusalsSayTheCardIsOutOfDate() {
        listOf("OWNER_CONFIRMATION_STALE", "OWNER_CONFIRMATION_NOTHING_TO_SEND_BACK", "OWNER_CONFIRMATION_TASK_SETTLED",
            "OWNER_CONFIRMATION_REVIEW_STALE", "OWNER_CONFIRMATION_ANSWERS_REQUIRED").forEach {
            assertEquals(it, "Not recorded: this card is out of date", OwnerReview.refusalTitle(it))
        }
        assertEquals("Not recorded", OwnerReview.refusalTitle("FORBIDDEN"))
        assertEquals("Not recorded", OwnerReview.refusalTitle(null))
    }

    /** Reopen task is offered under a receipt once the task has settled. */
    @Test fun reopenIsOfferedOnceTheTaskHasSettled() {
        assertTrue(OwnerReview.reopenOffered("DONE"))
        assertTrue(OwnerReview.reopenOffered("FAILED"))
        assertTrue(OwnerReview.reopenOffered("CANCELLED"))
        assertFalse(OwnerReview.reopenOffered("OPEN"))
        assertFalse(OwnerReview.reopenOffered(null))
    }

    // the card, its receipt and its return, in the conversation (the shared card corpus)

    private val raw = fixture().obj("snapshot")!!
    private val view = raw.obj("standing")!!.obj("ownerConfirmation")!!
    private val sid = fixture().text("sessionId")!!
    private val task = view.text("taskId")!!
    private fun cardsWith(owner: JsonObject) = cardList(JsonObject(raw + ("standing" to JsonObject(raw.obj("standing")!! + ("ownerConfirmation" to owner)))))
        .filter { it.family == CardFamily.OWNER_CONFIRMATION }
    private val problems = buildJsonObject {
        put("recordId", "p-rec"); put("recordedAt", "2026-10-04T01:00:00.000Z"); put("reviewedSha", JsonNull); put("reason", "Found later")
        putJsonArray("problems") { addJsonObject { put("key", "p1"); put("text", "Dark mode lost the card's border") } }
    }

    /** The question asks in the iOS words; the card is the waiting request's, under its own address. */
    @Test fun theQuestionIsAskedInTheCardsOwnWords() {
        val card = cardsWith(view).single()
        assertEquals("owner:$task:owner1", card.key)
        assertEquals("Confirm this task is done?", card.title)
        assertEquals("question", card.context.text("ownerCard"))
        assertEquals(listOf(CardVerb.CONFIRM_OWNER, CardVerb.SEND_BACK), card.actions)
    }

    /** A decision is drawn where its card was, as the receipt it left — and offers Reopen task only once the review found problems
     * after it and the task has settled (§9 L4), through the task's own door. */
    @Test fun aDecisionIsTheReceiptInTheCardsPlaceAndReopensASettledTask() {
        val review = JsonObject(view.obj("waiting")!!.obj("review")!! + ("problems" to problems))
        val decision = buildJsonObject {
            put("id", "d1"); put("decision", "CONFIRM"); put("decidedAt", "2026-10-04T00:30:00.000Z"); put("requestId", "owner1")
            put("sessionId", sid); put("review", review); putJsonArray("answers") {}
        }
        fun receipt(status: String) = cardsWith(JsonObject(view + ("status" to JsonPrimitive(status)) + ("decisions" to JsonArray(listOf(decision))))).single()
        val open = receipt("IN_PROGRESS")
        assertEquals("the receipt, not a question beside it", "owner:$task:owner1", open.key)
        assertEquals("Confirmed done", open.title)
        assertEquals("receipt", open.context.text("ownerCard"))
        assertTrue(open.actions.isEmpty())
        val settled = receipt("DONE")
        assertEquals(listOf(CardVerb.REOPEN_TASK), settled.actions)
        val reopen = CardRequests.build(settled, CardVerb.REOPEN_TASK)
        assertEquals(io.orbitd.android.core.net.HttpMethod.PATCH, reopen.method)
        assertEquals(listOf("tasks", task), reopen.path)
        assertEquals(buildJsonObject { put("status", "OPEN"); put("supersededByTaskId", JsonNull); put("terminalReason", JsonNull) },
            Wire.json.parseToJsonElement(reopen.body!!.decodeToString()))
        val sentBack = JsonObject(decision + ("decision" to JsonPrimitive("SEND_BACK")) + ("review" to JsonNull))
        val asked = cardsWith(JsonObject(view + ("status" to JsonPrimitive("DONE")) + ("decisions" to JsonArray(listOf(sentBack))))).single()
        assertEquals("Asked for more", asked.title)
        assertTrue("no review, no problems, nothing to reopen", asked.actions.isEmpty())
    }

    /** A report its reviewer sent back is a record in the card's place: the owner was not asked, so there is nothing to press. */
    @Test fun aReportItsReviewerSentBackIsARecordWithNothingToPress() {
        val bar = corpus.objects("bars").single { it.obj("review")!!.text("state") == "RETURNED" }.obj("review")!!
        val returned = buildJsonObject { put("requestId", "owner1"); put("sessionId", sid); put("requestedAt", "2026-10-04T00:00:00.000Z"); put("review", bar) }
        val card = cardsWith(JsonObject(view + ("reviewerReturns" to JsonArray(listOf(returned))))).single()
        assertEquals("owner:$task:owner1", card.key)
        assertEquals("returned", card.context.text("ownerCard"))
        assertEquals("Confirm this task is done?", card.title)
        assertTrue(card.actions.isEmpty())
        val other = JsonObject(returned + ("sessionId" to JsonPrimitive("someone-else")))
        assertEquals("another conversation's return is not drawn here", "question",
            cardsWith(JsonObject(view + ("reviewerReturns" to JsonArray(listOf(other))))).single().context.text("ownerCard"))
    }

    private fun assertNotNullReview(value: JsonElement?, case: String): JsonObject {
        val review = OwnerReview.readable(value)
        assertNotNull("$case: the fixture's review reads", review)
        return review!!
    }
}
