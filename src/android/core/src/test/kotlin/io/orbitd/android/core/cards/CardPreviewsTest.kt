package io.orbitd.android.core.cards

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/**
 * A08-2 (iOS 629e8b87d, 5a2458531): which of the shared corpus's cards the conversation shows as a compact preview that opens a
 * full-height review, what the preview says, and what the review says after this window's own press.
 */
class CardPreviewsTest {
    private val cards = cardList()
    private fun card(key: String) = cards.single { it.key == key }
    private val task = fixture().text("taskId")!!
    private val project = fixture().text("projectId")!!

    /** By kind, never by length: the decisions answered in a review are previews; a tool call, a provider write, a single create,
     * evidence, an exception and every receipt stay whole where they are. */
    @Test fun theLongDecisionsArePreviewsAndTheRestStayWhole() {
        val previews = cards.filter { CardPreviews.preview(it) != null }.map { it.key }
        assertEquals(listOf("approval:a2", "approval:a3", "approval:a5", "approval:a6", "approval:a7", "owner:$task:owner1", "criteria:intent1"),
            previews.take(7))
        assertTrue(previews.any { it.startsWith("acceptance:") })
        assertTrue("item:q1" in previews)
        assertTrue(previews.any { it.startsWith("promotion:") })
        listOf("approval:a1", "approval:a4", "approval:a4p", "approval:a8", "evidence:$task:7", "item:x1", "item:f1").forEach {
            assertNull(it, CardPreviews.preview(card(it)))
        }
        // A batch or a restructure the server did not preview is drawn whole: there is nothing to summarise.
        val bare = card("approval:a5").let { it.copy(source = JsonObject(it.source + ("input" to buildJsonObject { putJsonArray("tasks") {} }))) }
        assertNull(CardPreviews.preview(bare))
    }

    @Test fun eachPreviewSaysWhatItIsInIosWords() {
        fun of(key: String) = CardPreviews.preview(card(key))!!
        assertEquals(CardPreview("A question for you", "2 questions\nWhich scope?", PreviewTone.BLUE), of("approval:a2"))
        assertEquals("Review this plan", of("approval:a3").title)
        assertEquals("Plan\n\n1. Implement cards\n2. Verify server state", of("approval:a3").summary)
        assertEquals("Create 2 tasks?", of("approval:a5").title)
        assertEquals("1 waits on a prerequisite · 1 needs a manual start — nothing will trigger it", of("approval:a5").summary)
        assertEquals("Restructure dependencies in Cards?", of("approval:a6").title)
        assertEquals("2 changes · 1 → 2 edges", of("approval:a6").summary)
        assertEquals(CardPreview("Resolve blocker", "Supply review evidence.", PreviewTone.ORANGE), of("approval:a7"))
        assertEquals(CardPreview("Confirm this task is done?", "Card owner check", PreviewTone.BLUE), of("owner:$task:owner1"))
        assertEquals(CardPreview("Weaken this ruler?", "1 reworded, 0 unchanged", PreviewTone.ORANGE, badge = "criteria"), of("criteria:intent1"))
        assertEquals(CardPreview("When is this project done?", "Card project · 1 criteria", PreviewTone.BLUE),
            CardPreviews.preview(cards.single { it.key.startsWith("acceptance:") }))
        assertEquals(CardPreview("The coordinator has a question", "Which delivery?", PreviewTone.BLUE), of("item:q1"))
        val merge = CardPreviews.preview(cards.single { it.key.startsWith("promotion:") })!!
        assertEquals(CardPreview("Merge to main", "project/cards\n2 commits · 1 task\nNo checks recorded", PreviewTone.ORANGE, badge = "Needs you"), merge)
        assertEquals(CardPreviews.viewDetailsAndAct, merge.label)
    }

    /** A preview that asks nothing any more is dimmed, and only opens to be read. */
    @Test fun aPreviewThatAsksNothingIsDimmedAndSaysViewDetails() {
        val stale = card("approval:a2").copy(actions = emptyList(), status = CardPreviews.stale)
        assertTrue(CardPreviews.preview(stale)!!.dimmed)
        assertEquals("View details", CardPreviews.preview(stale)!!.label)
        val merging = card(cards.single { it.key.startsWith("promotion:") }.key).let {
            it.copy(source = JsonObject(it.source + ("state" to JsonPrimitive("CONFIRMED"))))
        }
        val preview = CardPreviews.preview(merging)!!
        assertEquals("Confirmed · main", preview.title)
        assertTrue(preview.dimmed)
        assertNull(preview.badge)
    }

    @Test fun aChangeSummarySaysWhatMovesAndWhatDoesNot() {
        assertEquals("nothing this reader could read", CardPreviews.changeSummary(null))
        assertEquals("nothing this reader could read", CardPreviews.changeSummary(buildJsonObject { putJsonArray("entries") {} }))
        val diff = buildJsonObject {
            putJsonArray("entries") { addJsonObject { put("change", "CHANGED") } }
            put("sameCount", 5); put("changedCount", 2); put("removedCount", 1); put("newCount", 1)
        }
        assertEquals("2 reworded, 1 dropped, 1 added, 5 unchanged", CardPreviews.changeSummary(diff))
        val still = buildJsonObject { putJsonArray("entries") { addJsonObject { put("change", "SAME") } }; put("sameCount", 3) }
        assertEquals("nothing moves, 3 unchanged", CardPreviews.changeSummary(still))
    }

    private fun state(busy: Boolean = false, settled: Boolean = false, uncertain: Boolean = false, status: String? = null,
        response: JsonObject? = null) = CardActionState(busy = busy, settled = settled, uncertain = uncertain,
        response = response ?: status?.let { buildJsonObject { put("status", it) } })

    /** After this window's press: an approval is sending, then its record only when the server recorded THIS press — another end's
     * answer keeps the card and its message; a Chat about this closes the review; a decision card is its record once taken; nothing
     * uncertain, refused or pressed elsewhere is a record. */
    @Test fun theReviewSaysWhatItsOwnPressDid() {
        val approval = card("approval:a1")
        assertEquals(CardPreviews.Phase.SENDING, CardPreviews.phase(approval, state(busy = true), CardVerb.ALLOW))
        assertEquals(CardPreviews.Phase.RECORDED, CardPreviews.phase(approval, state(settled = true, status = "ALLOWED"), CardVerb.ALLOW))
        assertEquals(CardPreviews.Phase.RECORDED, CardPreviews.phase(card("approval:a3"), state(settled = true, status = "DENIED"), CardVerb.KEEP_PLANNING))
        assertEquals("a chat closes the review", CardPreviews.Phase.CLOSED, CardPreviews.phase(approval, state(settled = true, status = "DENIED"), CardVerb.CHAT))
        assertEquals("another end answered first", CardPreviews.Phase.CARD, CardPreviews.phase(approval, state(settled = true, status = "DENIED"), CardVerb.ALLOW))
        assertEquals(CardPreviews.Phase.CARD, CardPreviews.phase(approval, state(uncertain = true), CardVerb.ALLOW))
        assertEquals("not pressed here", CardPreviews.Phase.CARD, CardPreviews.phase(approval, state(settled = true, status = "ALLOWED"), null))
        assertEquals(CardPreviews.Phase.CARD, CardPreviews.phase(approval, state(), CardVerb.ALLOW))
        val criteria = card("criteria:intent1")
        assertEquals(CardPreviews.Phase.RECORDED, CardPreviews.phase(criteria, state(settled = true), CardVerb.APPROVE_CRITERIA))
        assertEquals(CardPreviews.Phase.CARD, CardPreviews.phase(criteria, state(busy = true), CardVerb.APPROVE_CRITERIA))
        val owner = card("owner:$task:owner1")
        assertEquals(CardPreviews.Phase.RECORDED, CardPreviews.phase(owner, state(settled = true), CardVerb.CONFIRM_OWNER))
        assertEquals("a send-back is a conversation, not a record", CardPreviews.Phase.CARD, CardPreviews.phase(owner, state(settled = true), CardVerb.SEND_BACK))
        assertEquals(CardPreviews.Phase.CARD, CardPreviews.phase(card("item:q1"), state(settled = true), CardVerb.OWNER_ANSWER))
        assertTrue(project.isNotEmpty())
    }

    private val utc = java.time.ZoneOffset.UTC
    private val pressedAt = java.time.Instant.parse("2026-10-04T10:40:00Z")
    private fun record(card: InteractionCard, verb: CardVerb, response: JsonObject? = null, now: java.time.Instant = pressedAt) =
        CardPreviews.record(card, verb, state(settled = true, response = response), pressedAt, now, utc)

    /** An agent's ask answered here: "Answered", who did what and when — the server's time where it says it — and what came of it. */
    @Test fun anAnsweredAskIsItsRecord() {
        val allowed = buildJsonObject { put("status", "ALLOWED"); put("decidedAt", "2026-10-04T10:41:00.000Z") }
        assertEquals(CardRecord("Answered", CardRecord.Icon.CHECK, "Answered by you · 10:41", "Sent to the agent"),
            record(card("approval:a2"), CardVerb.ANSWER, allowed))
        assertEquals(CardRecord("Answered", CardRecord.Icon.CHECK, "Approved by you · 10:41", "The agent is running the plan"),
            record(card("approval:a3"), CardVerb.APPROVE_PLAN, allowed))
        assertEquals(CardRecord("Answered", CardRecord.Icon.KEPT, "Kept planning · by you · 10:40", "The agent goes on planning"),
            record(card("approval:a3"), CardVerb.KEEP_PLANNING, buildJsonObject { put("status", "DENIED") }))
        listOf("approval:a5" to CardVerb.CREATE_BATCH, "approval:a6" to CardVerb.CHANGE_DAG, "approval:a7" to CardVerb.RESOLVE_BLOCKER).forEach { (key, verb) ->
            assertEquals(key, CardRecord("Answered", CardRecord.Icon.CHECK, "Approved by you · 10:41", "Sent to the agent"), record(card(key), verb, allowed))
        }
        // On another day the time says the date too.
        assertEquals("Answered by you · 10/4 10:41", record(card("approval:a2"), CardVerb.ANSWER, allowed, java.time.Instant.parse("2026-10-05T09:00:00Z")).line)
    }

    /** A confirmation says which report it settled; one whose report has no time says nothing more. */
    @Test fun aConfirmedTaskIsItsRecord() {
        val owner = card("owner:$task:owner1")
        val decided = buildJsonObject { put("decision", "CONFIRM"); put("decidedAt", "2026-10-04T14:06:00.000Z") }
        assertEquals(CardRecord("Confirmed done", CardRecord.Icon.CHECK, "Confirmed done by you · 14:06", "Recorded on the 00:00 report"),
            record(owner, CardVerb.CONFIRM_OWNER, decided))
        val view = owner.context.obj("view")!!
        val untimed = JsonObject(view + ("waiting" to JsonObject(view.obj("waiting")!! + ("report" to buildJsonObject { put("text", "Done.") }))))
        assertNull(record(owner.copy(context = JsonObject(owner.context + ("view" to untimed))), CardVerb.CONFIRM_OWNER, decided).detail)
    }

    /** The project's start and its criteria: how many, at which seal, and what had changed since they were last confirmed. */
    @Test fun aStartAndAConfirmationAreTheirRecords() {
        val document = fixture().obj("snapshot")!!.obj("standing")!!.obj("project")!!
        val start = InteractionCard("start:start1", CardFamily.START, "Start this project?", fixture().obj("startItem")!!, "s", project, "start1",
            "seal1:plan1", listOf(CardVerb.START), context = document)
        assertEquals(CardRecord("Decision recorded", CardRecord.Icon.CHECK, "Started by you · 14:06", "On 3 criteria at seal a1b2c3d4e5f6"),
            record(start, CardVerb.START, buildJsonObject { put("startedAt", "2026-10-04T14:06:00.000Z"); put("criteriaDigest", "a1b2c3d4e5f6a7b8"); put("criteriaCount", 3) }))
        assertEquals("without an answer to read, the card's own seal and count", "On 1 criterion at seal seal1", record(start, CardVerb.START).detail)
        val acceptance = cards.single { it.key.startsWith("acceptance:") }
        val confirmed = buildJsonObject {
            put("state", "CONFIRMED")
            putJsonObject("currentVersion") { put("digest", "d4e5f6a7b8c9d0"); putJsonArray("material") { repeat(5) { addJsonObject { put("definitionId", "c$it") } } } }
            putJsonObject("confirmation") { put("confirmedAt", "2026-10-04T14:06:00.000Z") }
        }
        assertEquals(CardRecord("Decision recorded", CardRecord.Icon.CHECK, "Confirmed by you · 14:06", "5 criteria at seal d4e5f6a7b8c9"),
            record(acceptance, CardVerb.CONFIRM_CRITERIA, confirmed))
        val stale = acceptance.copy(source = JsonObject(acceptance.source + mapOf("state" to JsonPrimitive("STALE"), "changesSinceConfirmed" to buildJsonObject {
            putJsonArray("added") { addJsonObject { put("ordinal", 4) } }; putJsonArray("stricter") { addJsonObject { put("ordinal", 2) } }; putJsonArray("revised") {}
        })))
        assertEquals("5 criteria at seal d4e5f6a7b8c9 — 1 new, 1 stricter", record(stale, CardVerb.CONFIRM_CRITERIA, confirmed).detail)
    }

    /** "Weaken this ruler?": approved, it names the seal it left; refused, the seal the criteria stay at. */
    @Test fun aCriteriaDecisionIsItsRecord() {
        val criteria = card("criteria:intent1")
        val approved = buildJsonObject {
            put("decision", "APPROVE"); put("decidedAt", "2026-10-04T14:06:00.000Z"); put("baseSeal", "d4e5f6"); put("resultingSeal", "e7f8a9")
        }
        assertEquals(CardRecord("Decision recorded", CardRecord.Icon.CHECK, "Approved by you · 14:06", "Re-sealed: d4e5f6 → e7f8a9"),
            record(criteria, CardVerb.APPROVE_CRITERIA, approved))
        assertNull("no resulting seal, no detail", record(criteria, CardVerb.APPROVE_CRITERIA).detail)
        assertEquals(CardRecord("Decision recorded", CardRecord.Icon.REFUSED, "Refused by you · 10:40", "The criteria stay at seal seal1"),
            record(criteria, CardVerb.REJECT_CRITERIA))
    }

    @Test fun theWordsAreIosOwn() {
        assertEquals("View details", CardPreviews.viewDetails)
        assertEquals("View details & act", CardPreviews.viewDetailsAndAct)
        assertEquals("Sending your answer…", CardPreviews.sending)
        assertEquals("Answered", CardPreviews.answeredTitle)
        assertEquals("Decision recorded", CardPreviews.decisionRecorded)
        assertEquals("Sent to the agent", CardPreviews.sentToTheAgent)
        assertEquals("YOUR ANSWER", CardPreviews.yourAnswer)
        assertEquals("This request is no longer waiting for an answer.", CardPreviews.noLongerWaiting)
        assertEquals("Request closed", CardPreviews.requestClosed)
    }
}
