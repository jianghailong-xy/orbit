package io.orbitd.android.core.cards

import io.orbitd.android.core.realtime.RunEvent
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.time.Instant

/** The five Orbit turn cards (docs/mocks/orbit-turn-cards/): parsed off a user turn's payload, never half a card, never off an agent's. */
class OrbitTurnCardsTest {
    private fun turn(field: String, seq: Long = 1, type: String = "user", body: JsonObjectBuilder.() -> Unit) =
        RunEvent(type, seq, buildJsonObject { putJsonObject(field, body); put("text", "") })

    private fun only(event: RunEvent) = transcriptCards(event).single()
    private val due = "2026-11-11T05:35:30Z"
    private val before = Instant.parse("2026-11-11T05:10:00Z")
    private val after = Instant.parse("2026-11-11T06:00:00Z")
    private fun at(iso: String, now: Instant) = OwnerReview.receiptTime(iso, now)!!

    private val review: JsonObjectBuilder.() -> Unit = {
        put("evidenceId", "e"); put("taskId", "t"); put("title", "iOS welcome card"); put("revision", "1")
        put("runSessionId", "r"); put("dueAt", due); put("claim", "Both apps show it."); put("state", "OPEN")
        put("latestRevision", "1"); put("decision", JsonNull)
    }

    @Test fun evidenceToReview() {
        val card = only(turn("evidenceReview", body = review))
        assertEquals(CardFamily.REVIEW, card.family)
        assertEquals(OrbitTurnCards.evidenceToReview, card.title)
        assertTrue(card.key.endsWith(":evidenceReview"))
        val source = card.source
        assertEquals("Revision 1 · Due ${at(due, before)}", OrbitTurnCards.evidenceReviewMeta(source, before))
        assertEquals(OrbitTurnCards.StateLine("This session decides it. If it hasn't by ${at(due, before)}, you're asked."),
            OrbitTurnCards.evidenceReviewState(source, before))
        assertEquals(OrbitTurnCards.StateLine("You were asked at ${at(due, after)}.", OrbitTurnCards.Tone.WARNING),
            OrbitTurnCards.evidenceReviewState(source, after))
        assertTrue(OrbitTurnCards.evidenceReviewOpen(source))
        fun state(vararg over: Pair<String, String?>) = OrbitTurnCards.evidenceReviewState(buildJsonObject {
            source.forEach { (k, v) -> put(k, v) }; over.forEach { (k, v) -> put(k, v) }
        }, before)
        assertEquals("This session decides it.", state("dueAt" to null).text)
        assertEquals("Revision 2 replaced it. Nothing to decide.", state("state" to "SUPERSEDED", "latestRevision" to "2").text)
        assertEquals(OrbitTurnCards.StateLine("Confirmed.", OrbitTurnCards.Tone.SUCCESS), state("state" to "DECIDED", "decision" to "CONFIRM"))
        assertEquals("Sent back.", state("state" to "DECIDED", "decision" to "SEND_BACK").text)
        assertEquals("The task is closed. Nothing to decide.", state("state" to "CLOSED").text)
        assertEquals("Revision 1", OrbitTurnCards.evidenceReviewMeta(buildJsonObject { put("revision", "1") }, before))
        // Malformed: no title, no state — no card. An agent's event carries none.
        assertTrue(transcriptCards(turn("evidenceReview") { review(); put("title", JsonNull) }).isEmpty())
        assertTrue(transcriptCards(turn("evidenceReview") { review(); put("state", "") }).isEmpty())
        assertTrue(transcriptCards(turn("evidenceReview", type = "assistant", body = review)).isEmpty())
    }

    @Test fun evidenceSentBack() {
        val body: JsonObjectBuilder.() -> Unit = {
            put("decisionId", "d"); put("taskId", "t"); put("title", "iOS welcome card"); put("revision", "1")
            put("note", "Add the Mac screenshot."); put("by", "SESSION"); put("bySessionId", "s"); put("byTitle", "Welcome card")
        }
        val card = only(turn("evidenceSendBack", body = body))
        assertEquals(CardFamily.REVIEW, card.family)
        assertEquals(OrbitTurnCards.evidenceSentBack, card.title)
        assertEquals("Revision 1 · by ", OrbitTurnCards.sentBackPrefix(card.source))
        assertEquals("Welcome card", OrbitTurnCards.sentBackBy(card.source))
        assertEquals("you", OrbitTurnCards.sentBackBy(only(turn("evidenceSendBack") { body(); put("by", "OWNER") }).source))
        assertEquals("a session", OrbitTurnCards.sentBackBy(only(turn("evidenceSendBack") { body(); put("byTitle", JsonNull) }).source))
        assertTrue(transcriptCards(turn("evidenceSendBack") { body(); put("by", JsonNull) }).isEmpty())
        assertTrue(transcriptCards(turn("evidenceSendBack", type = "assistant", body = body)).isEmpty())
    }

    @Test fun questionFromATaskRun() {
        val replyBy = "2026-11-11T06:10:00Z"
        val body: JsonObjectBuilder.() -> Unit = {
            put("requestId", "q"); put("approvalId", "a"); put("taskId", "t"); put("taskTitle", "K4 held tasks"); put("runSessionId", "r")
            put("replyBy", replyBy); put("state", "OPEN"); put("approvalStatus", "PENDING")
            putJsonArray("questions") { addJsonObject {
                put("question", "Keep its place?")
                putJsonArray("options") { addJsonObject { put("label", "Keep its place") }; addJsonObject { put("label", "Go to the back") } }
            } }
            put("answers", JsonNull); put("answeredBy", JsonNull)
        }
        val card = only(turn("runQuestion", body = body))
        assertEquals(CardFamily.SESSION_REQUEST, card.family)
        assertEquals(OrbitTurnCards.questionFromRun, card.title)
        assertEquals("K4 held tasks", OrbitTurnCards.runTaskTitle(card.source))
        assertEquals(listOf(OrbitTurnCards.Question("Keep its place?",
            listOf(OrbitTurnCards.Option("Keep its place", false), OrbitTurnCards.Option("Go to the back", false)), emptyList())),
            OrbitTurnCards.runQuestions(card.source))
        val now = Instant.parse("2026-11-11T05:40:00Z")
        assertEquals("The run is waiting. This session answers it; if it hasn't by ${at(replyBy, now)}, you're asked.",
            OrbitTurnCards.runQuestionState(card.source, now).text)
        assertEquals(OrbitTurnCards.StateLine("Passed to you at ${at(replyBy, after.plusSeconds(3600))}.", OrbitTurnCards.Tone.WARNING),
            OrbitTurnCards.runQuestionState(card.source, after.plusSeconds(3600)))
        val answered = only(turn("runQuestion") {
            body(); put("approvalStatus", "ALLOWED"); put("state", "REPLIED"); put("answeredBy", "SESSION")
            putJsonObject("answers") { putJsonArray("Keep its place?") { add("Keep its place"); add("Only until Friday") } }
        }).source
        assertEquals(listOf(OrbitTurnCards.Question("Keep its place?",
            listOf(OrbitTurnCards.Option("Keep its place", true), OrbitTurnCards.Option("Go to the back", false)), listOf("Only until Friday"))),
            OrbitTurnCards.runQuestions(answered))
        assertEquals(OrbitTurnCards.StateLine("Answered by this session.", OrbitTurnCards.Tone.SUCCESS), OrbitTurnCards.runQuestionState(answered, now))
        assertTrue(OrbitTurnCards.answered(answered))
        assertEquals("Answered by you.", OrbitTurnCards.runQuestionState(buildJsonObject { put("answeredBy", "OWNER") }, now).text)
        assertEquals("Closed without an answer.", OrbitTurnCards.runQuestionState(buildJsonObject {
            put("replyBy", replyBy); put("state", "UNDELIVERED"); put("approvalStatus", "ABANDONED") }, now).text)
        assertEquals(OrbitTurnCards.aTaskRun, OrbitTurnCards.runTaskTitle(only(turn("runQuestion") { body(); put("taskTitle", "") }).source))
        assertTrue(transcriptCards(turn("runQuestion") { body(); put("replyBy", JsonNull) }).isEmpty())
        assertTrue(transcriptCards(turn("runQuestion", type = "assistant", body = body)).isEmpty())

        // The stored card was read before anyone answered; its request's card as it stands now is drawn over it.
        val request = buildJsonObject { put("id", "q"); put("state", "REPLIED"); put("runQuestion", answered) }
        val shown = OrbitTurnCards.runQuestionShown(card.source, request)
        assertEquals(answered, shown)
        assertEquals(OrbitTurnCards.StateLine("Answered by this session.", OrbitTurnCards.Tone.SUCCESS), OrbitTurnCards.runQuestionState(shown, now))
        assertEquals(listOf(OrbitTurnCards.Option("Keep its place", true), OrbitTurnCards.Option("Go to the back", false)),
            OrbitTurnCards.runQuestions(shown).single().options)
        val ownerAnswered = buildJsonObject { answered.forEach { (k, v) -> put(k, v) }; put("state", "OWNER_ANSWERED"); put("answeredBy", "OWNER") }
        assertEquals("Answered by you.", OrbitTurnCards.runQuestionState(
            OrbitTurnCards.runQuestionShown(card.source, buildJsonObject { put("runQuestion", ownerAnswered) }), now).text)
        // Passed to the owner: the live card's wording, not the stored one's.
        val passed = buildJsonObject { card.source.forEach { (k, v) -> put(k, v) }; put("state", "NO_REPLY") }
        assertEquals("Passed to you at ${at(replyBy, now)}.", OrbitTurnCards.runQuestionState(
            OrbitTurnCards.runQuestionShown(card.source, buildJsonObject { put("runQuestion", passed) }), now).text)
        // No request read, a request without the card, or a malformed one: the stored card.
        assertSame(card.source, OrbitTurnCards.runQuestionShown(card.source, null))
        assertSame(card.source, OrbitTurnCards.runQuestionShown(card.source, buildJsonObject { put("id", "q") }))
        assertSame(card.source, OrbitTurnCards.runQuestionShown(card.source, buildJsonObject {
            put("runQuestion", buildJsonObject { answered.forEach { (k, v) -> put(k, v) }; put("replyBy", JsonNull) }) }))
        // A stored card that already names its answerer never changes: the request's card is not used (and the view does not read it).
        val live = buildJsonObject { put("runQuestion", ownerAnswered) }
        assertSame(answered, OrbitTurnCards.runQuestionShown(answered, live))
        assertEquals("Answered by this session.", OrbitTurnCards.runQuestionState(OrbitTurnCards.runQuestionShown(answered, live), now).text)
    }

    @Test fun noticeFromATaskRun() {
        val body: JsonObjectBuilder.() -> Unit = {
            put("requestId", "n"); put("taskId", "t"); put("taskTitle", "Three clients"); put("runSessionId", "r")
            put("message", "The emulator is down."); put("state", "OPEN")
        }
        val card = only(turn("runNotice", body = body))
        assertEquals(CardFamily.SESSION_REQUEST, card.family)
        assertEquals(OrbitTurnCards.noticeFromRun, card.title)
        assertEquals("Nothing to reply to. It did not reach you.", OrbitTurnCards.noticeState)
        assertTrue(transcriptCards(turn("runNotice") { body(); put("runSessionId", JsonNull) }).isEmpty())
        assertTrue(transcriptCards(turn("runNotice", type = "assistant", body = body)).isEmpty())
    }

    @Test fun theOpeningOfASessionOrbitOpened() {
        fun opening(kind: String, targetKind: String? = null, mention: String? = null) = only(turn("sessionOpening") {
            put("kind", kind)
            if (targetKind != null) putJsonObject("target") { put("kind", targetKind); put("id", "x"); put("title", "Baseline red") }
            else put("target", JsonNull)
            put("mention", mention)
        }).source
        assertEquals("Orbit started this session as the coordinator of " to "Baseline red",
            OrbitTurnCards.openingSentence(opening("COORDINATOR", "PROJECT")))
        assertEquals("orbit-project:x", OrbitTurnCards.openingLink(opening("COORDINATOR", "PROJECT")))
        assertEquals("Orbit started this session to judge " to "Baseline red", OrbitTurnCards.openingSentence(opening("JUDGMENT", "TASK")))
        assertEquals("orbit-task:x", OrbitTurnCards.openingLink(opening("JUDGMENT", "TASK")))
        assertEquals("Orbit started this session to dispatch the list " to "Baseline red",
            OrbitTurnCards.openingSentence(opening("DISPATCH", "LIST")))
        assertEquals("orbit-list:x", OrbitTurnCards.openingLink(opening("DISPATCH", "LIST")))
        val mention = opening("MENTION", "TASK", "@agent check the sender domain")
        assertEquals("Orbit started this session for your mention on " to "Baseline red", OrbitTurnCards.openingSentence(mention))
        assertEquals("@agent check the sender domain", OrbitTurnCards.openingMention(mention))
        assertNull(OrbitTurnCards.openingMention(opening("COORDINATOR", "PROJECT", "stray")))
        assertEquals("Orbit started this session" to null, OrbitTurnCards.openingSentence(opening("OTHER")))
        assertEquals("Orbit started this session" to null, OrbitTurnCards.openingSentence(opening("COORDINATOR")))
        assertTrue(transcriptCards(turn("sessionOpening") { put("kind", "SOMETHING") }).isEmpty())
        assertTrue(transcriptCards(turn("sessionOpening", type = "assistant") { put("kind", "COORDINATOR") }).isEmpty())
    }
}
