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

    /** After this window's press: an approval is sending, then "Answer sent" only when the server recorded THIS press — another
     * end's answer keeps the card and its message; a decision card is "Decision recorded" once taken; nothing uncertain, refused or
     * pressed elsewhere is a receipt. */
    @Test fun theReviewSaysWhatItsOwnPressDid() {
        val approval = card("approval:a1")
        fun state(busy: Boolean = false, settled: Boolean = false, uncertain: Boolean = false, status: String? = null) =
            CardActionState(busy = busy, settled = settled, uncertain = uncertain, response = status?.let { buildJsonObject { put("status", it) } })
        assertEquals(CardPreviews.Phase.SENDING, CardPreviews.phase(approval, state(busy = true), CardVerb.ALLOW))
        assertEquals(CardPreviews.Phase.ANSWER_SENT, CardPreviews.phase(approval, state(settled = true, status = "ALLOWED"), CardVerb.ALLOW))
        assertEquals(CardPreviews.Phase.ANSWER_SENT, CardPreviews.phase(approval, state(settled = true, status = "DENIED"), CardVerb.CHAT))
        assertEquals("another end answered first", CardPreviews.Phase.CARD, CardPreviews.phase(approval, state(settled = true, status = "DENIED"), CardVerb.ALLOW))
        assertEquals(CardPreviews.Phase.CARD, CardPreviews.phase(approval, state(uncertain = true), CardVerb.ALLOW))
        assertEquals("not pressed here", CardPreviews.Phase.CARD, CardPreviews.phase(approval, state(settled = true, status = "ALLOWED"), null))
        assertEquals(CardPreviews.Phase.CARD, CardPreviews.phase(approval, state(), CardVerb.ALLOW))
        val criteria = card("criteria:intent1")
        assertEquals(CardPreviews.Phase.DECISION_RECORDED, CardPreviews.phase(criteria, state(settled = true), CardVerb.APPROVE_CRITERIA))
        assertEquals(CardPreviews.Phase.CARD, CardPreviews.phase(criteria, state(busy = true), CardVerb.APPROVE_CRITERIA))
        val owner = card("owner:$task:owner1")
        assertEquals(CardPreviews.Phase.DECISION_RECORDED, CardPreviews.phase(owner, state(settled = true), CardVerb.CONFIRM_OWNER))
        assertEquals("a send-back is a conversation, not a receipt", CardPreviews.Phase.CARD, CardPreviews.phase(owner, state(settled = true), CardVerb.SEND_BACK))
        assertEquals(CardPreviews.Phase.CARD, CardPreviews.phase(card("item:q1"), state(settled = true), CardVerb.OWNER_ANSWER))
        assertTrue(project.isNotEmpty())
    }

    @Test fun theWordsAreIosOwn() {
        assertEquals("View details", CardPreviews.viewDetails)
        assertEquals("View details & act", CardPreviews.viewDetailsAndAct)
        assertEquals("Sending your answer…", CardPreviews.sending)
        assertEquals("Answer sent", CardPreviews.answerSent)
        assertEquals("The agent has been told, and this request has nothing left to answer.", CardPreviews.answerSentDetail)
        assertEquals("Decision recorded", CardPreviews.decisionRecorded)
        assertEquals("The conversation keeps the record where it was made.", CardPreviews.decisionRecordedDetail)
        assertEquals("This request is no longer waiting for an answer.", CardPreviews.noLongerWaiting)
        assertEquals("Request closed", CardPreviews.requestClosed)
    }
}
