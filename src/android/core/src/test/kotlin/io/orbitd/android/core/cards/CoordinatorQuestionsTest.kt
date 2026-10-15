package io.orbitd.android.core.cards

import io.orbitd.android.core.protocol.Wire
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.time.Instant
import java.time.ZoneOffset

/**
 * What a coordinator's question becomes once it has ended (A08-13; OrbitKit `CoordinatorQuestions`, `CoordinatorQuestionRecordTests`):
 * the folded record and its replay, line by line; the record an answer pressed here stands as until the read has it; the order two
 * records are drawn in; the withdrawn words; and the catalogue drawing each record where its question card was, asking nothing.
 */
class CoordinatorQuestionsTest {
    private val zone = ZoneOffset.UTC
    private val askedAt = "2026-10-09T00:10:00.000Z"
    private val answeredAt = "2026-10-09T00:29:36.828Z"
    private val now = Instant.parse("2026-10-09T01:00:00.000Z")

    private val question = buildJsonObject {
        put("question", "The rollback's follow-ups are done:\n\n- maintenance resumed after the deploy\n- **all three fixes** are in production\n\nApprove reopening the rollout.")
        putJsonArray("options") {
            addJsonObject { put("label", "Reopen now, accept the cost"); put("description", "No special timing.") }
            addJsonObject { put("label", "Switch when the next round starts"); put("description", "Watch the next maintenance window.") }
            addJsonObject { put("label", "Do not reopen yet") }
        }
        put("recommendedOption", 0); putJsonArray("blocksTaskIds") { add("t4") }; put("ifUnanswered", "the rollout stays paused")
    }
    private val free = buildJsonObject { put("question", "Run the rewrite at night or during the day?"); putJsonArray("options") {}; put("recommendedOption", JsonNull) }

    private fun record(itemId: String = "item-1", option: Int? = 0, text: String? = null, delivered: Boolean = true, question: JsonObject = this.question,
        resolvedAt: String = answeredAt) = buildJsonObject {
        put("itemId", itemId); put("question", question); put("askedAt", askedAt); put("resolution", "ANSWERED"); put("resolvedBy", "USER")
        put("resolvedAt", resolvedAt)
        putJsonObject("answer") { put("option", option?.let(::JsonPrimitive) ?: JsonNull); put("text", text) }
        put("delivery", if (delivered) buildJsonObject { put("sessionId", "coordinator-1"); put("at", resolvedAt) } else JsonNull)
        put("withdrawReason", JsonNull)
    }
    private fun withdrawn(by: String = "COORDINATOR") = buildJsonObject {
        put("itemId", "item-1"); put("question", question); put("askedAt", askedAt); put("resolution", "WITHDRAWN"); put("resolvedBy", by)
        put("resolvedAt", answeredAt); put("answer", JsonNull); put("delivery", JsonNull); put("withdrawReason", " The rollout was rolled back; this step is not needed. ")
    }
    private fun clock(iso: String) = OwnerReview.receiptTime(iso, now, zone)!!

    // MARK: the folded card

    @Test fun theCardOpensWithTheQuestionAsPlainTextInTwoLines() {
        assertEquals("The rollback's follow-ups are done: maintenance resumed after the deploy all three fixes are in production Approve reopening the rollout.",
            CoordinatorQuestions.lead(question))
        assertEquals("first second", CoordinatorQuestions.lead(buildJsonObject { put("question", "1. first\n2) *second*") }))
    }

    @Test fun anOptionAloneIsItsLabelAndANoteIsALineOfItsOwn() {
        val answered = record()
        assertEquals("Answered", CoordinatorQuestions.recordHeading(answered))
        assertEquals(clock(answeredAt), CoordinatorQuestions.time(answered, now, zone))
        assertEquals("Reopen now, accept the cost", CoordinatorQuestions.answerLine(answered))
        assertNull(CoordinatorQuestions.noteLine(answered)); assertNull(CoordinatorQuestions.waitingLine(answered))
        assertNull(CoordinatorQuestions.withdrewLine(answered)); assertNull(CoordinatorQuestions.withdrawReasonLine(answered))
        val noted = record(option = 1, text = " After 22:00 tonight; people use it by day. ")
        assertEquals("Switch when the next round starts", CoordinatorQuestions.answerLine(noted))
        assertEquals("“After 22:00 tonight; people use it by day.”", CoordinatorQuestions.noteLine(noted))
    }

    @Test fun ownWordsAreQuotedAndAnAnswerNoCoordinatorHasHadSaysItWaits() {
        assertEquals("“Hold the files until I have read the export script.”",
            CoordinatorQuestions.answerLine(record(option = null, text = "Hold the files until I have read the export script.")))
        assertEquals("“At night; I will look in the morning.”", CoordinatorQuestions.answerLine(record(option = null, text = "At night; I will look in the morning.", question = free)))
        assertEquals("Waiting for this project’s next coordinator", CoordinatorQuestions.waitingLine(record(delivered = false)))
        assertNull("an option the question never offered ticks nothing", CoordinatorQuestions.answerLine(record(option = 7)))
    }

    @Test fun aWithdrawnQuestionSaysWhoTookItBackAndWhy() {
        val taken = withdrawn()
        assertEquals("Withdrawn", CoordinatorQuestions.recordHeading(taken))
        assertNull(CoordinatorQuestions.answerLine(taken)); assertNull(CoordinatorQuestions.noteLine(taken))
        assertNull("nothing is owed to anybody", CoordinatorQuestions.waitingLine(taken))
        assertEquals("The coordinator withdrew it", CoordinatorQuestions.withdrewLine(taken))
        assertEquals("“The rollout was rolled back; this step is not needed.”", CoordinatorQuestions.withdrawReasonLine(taken))
        assertEquals("You withdrew it", CoordinatorQuestions.withdrewLine(withdrawn(by = "USER")))
    }

    // MARK: the replay

    @Test fun theReplayTicksTheAnswerAndSaysWhoEndedItAndWhereItWent() {
        val noted = record(option = 1, text = "After 22:00 tonight.")
        assertEquals("asked ${clock(askedAt)}", CoordinatorQuestions.askedAtLine(noted, now, zone))
        assertEquals(1, CoordinatorQuestions.chosenOption(noted))
        assertEquals("After 22:00 tonight.", CoordinatorQuestions.note(noted))
        assertFalse(CoordinatorQuestions.choseOther(noted)); assertNull(CoordinatorQuestions.ownWords(noted))
        val other = record(option = null, text = "Hold the files.")
        assertNull(CoordinatorQuestions.chosenOption(other)); assertTrue(CoordinatorQuestions.choseOther(other))
        assertEquals("Hold the files.", CoordinatorQuestions.ownWords(other)); assertNull(CoordinatorQuestions.note(other))
        val words = record(option = null, text = "At night.", question = free)
        assertFalse("there is no Other row to tick", CoordinatorQuestions.choseOther(words))
        assertEquals("At night.", CoordinatorQuestions.ownWords(words))
        val taken = withdrawn()
        assertNull(CoordinatorQuestions.chosenOption(taken)); assertFalse(CoordinatorQuestions.choseOther(taken))
        assertNull(CoordinatorQuestions.note(taken)); assertNull(CoordinatorQuestions.ownWords(taken))
        val at = clock(answeredAt)
        assertEquals("Answered by you · $at", CoordinatorQuestions.footerLine(record(), now, zone))
        assertEquals("Delivered to the current coordinator", CoordinatorQuestions.footerDetail(record()))
        assertEquals("Waiting for this project’s next coordinator", CoordinatorQuestions.footerDetail(record(delivered = false)))
        assertEquals("Withdrawn by the coordinator · $at", CoordinatorQuestions.footerLine(taken, now, zone))
        assertEquals("“The rollout was rolled back; this step is not needed.”", CoordinatorQuestions.footerDetail(taken))
        assertEquals("Withdrawn by you · $at", CoordinatorQuestions.footerLine(withdrawn(by = "USER"), now, zone))
        val later = Instant.parse("2026-10-12T09:00:00.000Z")
        assertEquals("the clock with the day in front of it once it is not today", "10/9 ${clock(answeredAt)}", CoordinatorQuestions.time(record(), later, zone))
    }

    // MARK: the press, until the read has it

    @Test fun theAnswerSentHereIsTheRecordTheReadWillPublish() {
        val row = buildJsonObject { put("itemId", "item-1"); put("kind", "COORDINATOR_QUESTION"); put("waitingSince", askedAt); put("question", question) }
        val at = Instant.parse(answeredAt)
        val sent = CoordinatorQuestions.answeredHere(row, 1, " tonight ", buildJsonObject {
            put("itemId", "item-1"); putJsonObject("delivery") { put("sessionId", "coordinator-1"); put("turnId", "turn-1") } }, at)
        assertTrue(CoordinatorQuestions.readable(sent))
        assertEquals(question, sent.obj("question"))
        assertEquals(askedAt, sent.text("askedAt")); assertEquals("ANSWERED", sent.text("resolution")); assertEquals("USER", sent.text("resolvedBy"))
        assertEquals(at, Instant.parse(sent.text("resolvedAt")))
        assertEquals("coordinator-1", sent.obj("delivery")?.text("sessionId"))
        assertEquals("Switch when the next round starts", CoordinatorQuestions.answerLine(sent))
        assertEquals("“tonight”", CoordinatorQuestions.noteLine(sent))
        val nobody = CoordinatorQuestions.answeredHere(row, null, "later", buildJsonObject { put("itemId", "item-1"); put("delivery", JsonNull) }, at)
        assertNull(nobody.obj("delivery"))
        assertEquals("Waiting for this project’s next coordinator", CoordinatorQuestions.waitingLine(nobody))
        assertEquals("“later”", CoordinatorQuestions.answerLine(nobody))
    }

    // MARK: where the record is drawn

    private fun items(open: List<JsonObject> = emptyList(), closed: List<JsonObject>? = null) = buildJsonObject {
        putJsonArray("needsYou") { open.forEach { add(it) } }; putJsonArray("withCoordinator") {}
        closed?.let { putJsonArray("closedQuestions") { it.forEach { record -> add(record) } } }
    }
    private fun openQuestion(itemId: String = "item-1") = buildJsonObject {
        put("itemId", itemId); put("kind", "COORDINATOR_QUESTION"); put("title", "Coordinator asks"); put("detailLine", "A decision is needed.")
        put("assignee", "OWNER"); put("assigneeReason", "DEFAULT"); put("waitingSince", askedAt); put("taskId", JsonNull); put("promotionId", JsonNull)
        putJsonArray("actions") { add("ANSWER") }; put("question", question)
    }
    private fun catalog(openItems: JsonObject, answered: Map<String, JsonObject> = emptyMap()) = CardCatalog.project("s1", "p1",
        mapOf("project" to buildJsonObject { put("id", "p1") }, "openItems" to openItems), answered)

    /** The read is newest first; records are drawn oldest first, so two answered seconds apart read in the order they were answered. */
    @Test fun recordsAreDrawnInTheOrderTheyEnded() {
        val read = items(closed = listOf(record("second", resolvedAt = "2026-10-09T00:29:36.000Z"), record("first", resolvedAt = "2026-10-09T00:29:23.000Z"),
            record("yesterday", resolvedAt = "2026-10-08T14:05:00.000Z")))
        assertEquals(listOf("yesterday", "first", "second"), CoordinatorQuestions.receipts(read).map { it.text("itemId") })
        assertEquals(listOf("item:yesterday", "item:first", "item:second"), catalog(read).map { it.key })
        // Two that ended in the same instant keep the order they happened in: the read's reversed.
        val tie = items(closed = listOf(record("b", resolvedAt = answeredAt), record("a", resolvedAt = answeredAt)))
        assertEquals(listOf("a", "b"), CoordinatorQuestions.receipts(tie).map { it.text("itemId") })
        assertTrue(CoordinatorQuestions.receipts(null).isEmpty())
        assertTrue("a server that predates the records has none", CoordinatorQuestions.receipts(items()).isEmpty())
    }

    /** Each record is drawn under its question card's address, asks nothing and is counted by nothing; the question it ended goes. */
    @Test fun theRecordStandsWhereItsQuestionWasAndAsksNothing() {
        val open = catalog(items(open = listOf(openQuestion())))
        assertEquals(CardFamily.OWNER_QUESTION, open.single().family)
        val ended = catalog(items(closed = listOf(record()))).single()
        assertEquals(open.single().key, ended.key)
        assertEquals(CardFamily.QUESTION_RECORD, ended.family)
        assertEquals("Answered", ended.title)
        assertTrue(ended.actions.isEmpty())
        assertNull("a record is no preview of a question", CardPreviews.preview(ended))
        assertNull(CardDiscussion.context(ended))
        // A record this build cannot read is not drawn, and does not take the open questions down with it.
        val odd = catalog(items(open = listOf(openQuestion("open-1")), closed = listOf(buildJsonObject { put("itemId", "q1") })))
        assertEquals(listOf("item:open-1"), odd.map { it.key })
    }

    /** Pressed here, the answer is its record at once — over a read that left before the answer and still lists the question — and the
     * read's own copy replaces it once it has one. */
    @Test fun theAnswerPressedHereStandsUntilTheReadHasIt() {
        val row = openQuestion()
        val local = CoordinatorQuestions.answeredHere(row, 0, null, buildJsonObject { putJsonObject("delivery") { put("sessionId", "c1"); put("turnId", "t") } },
            Instant.parse(answeredAt))
        val stale = catalog(items(open = listOf(row)), mapOf("item-1" to local))
        assertEquals(listOf("item:item-1"), stale.map { it.key })
        assertEquals(CardFamily.QUESTION_RECORD, stale.single().family)
        assertEquals(local, stale.single().source)
        val server = record(text = "the read's own copy")
        val read = catalog(items(closed = listOf(server)), mapOf("item-1" to local)).single()
        assertEquals(server, read.source)
        // An answer to one question leaves another standing open.
        val other = catalog(items(open = listOf(row, openQuestion("item-2"))), mapOf("item-1" to local))
        assertEquals(listOf(CardFamily.QUESTION_RECORD to "item:item-1", CardFamily.OWNER_QUESTION to "item:item-2"), other.map { it.family to it.key })
    }

    @Test fun theReadDecodesTheRecords() {
        val read = Wire.json.parseToJsonElement("""{"needsYou":[],"withCoordinator":[],"closedQuestions":[
          {"itemId":"q1","question":{"question":"Which first?","options":[{"label":"t4"},{"label":"t7","description":"why"}],"recommendedOption":0,
           "blocksTaskIds":[],"ifUnanswered":null},"askedAt":"2026-10-09T00:10:00.000Z","resolution":"ANSWERED","resolvedBy":"USER",
           "resolvedAt":"2026-10-09T00:29:36.828Z","answer":{"option":1,"text":null},"delivery":{"sessionId":"s1","at":"2026-10-09T00:29:37.000Z"},"withdrawReason":null},
          {"itemId":"q2","question":{"question":"Keep the branch?","options":[],"recommendedOption":null,"blocksTaskIds":[],"ifUnanswered":null},
           "askedAt":"2026-10-09T00:00:00.000Z","resolution":"WITHDRAWN","resolvedBy":"COORDINATOR","resolvedAt":"2026-10-09T00:20:00.000Z",
           "answer":null,"delivery":null,"withdrawReason":"not needed"}]}""").jsonObject
        val receipts = CoordinatorQuestions.receipts(read)
        assertEquals(listOf("q2", "q1"), receipts.map { it.text("itemId") })
        assertEquals("t7", CoordinatorQuestions.answerLine(receipts[1]))
        assertTrue(CoordinatorQuestions.withdrawn(receipts[0]))
        assertEquals("“not needed”", CoordinatorQuestions.withdrawReasonLine(receipts[0]))
    }

    // MARK: the words are iOS's

    @Test fun everyWordIsOrbitKits() {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
            .first { File(it, "src/macos/OrbitKit/Sources/OrbitKit/App/OwnerItemCards.swift").isFile }
        val swift = File(root, "src/macos/OrbitKit/Sources/OrbitKit/App/OwnerItemCards.swift").readText()
        listOf(CoordinatorQuestions.answeredHeading, CoordinatorQuestions.withdrawnHeading, CoordinatorQuestions.provenance, CoordinatorQuestions.recommended,
            CoordinatorQuestions.deliveredToCoordinator, CoordinatorQuestions.waitingForCoordinator, CoordinatorQuestions.freeAnswerPrompt,
            CoordinatorQuestions.otherOption, CoordinatorQuestions.answeredByYou, CoordinatorQuestions.withdrawnByCoordinator, CoordinatorQuestions.withdrawnByYou,
            CoordinatorQuestions.coordinatorWithdrew, CoordinatorQuestions.youWithdrew, CoordinatorQuestions.yourNote, CoordinatorQuestions.viewDetails,
        ).forEach { assertTrue("OwnerItemCards.swift no longer says \"$it\"", swift.contains("\"$it\"")) }
        assertTrue(swift.contains("\"asked \\(\$0)\""))
        assertTrue(swift.contains("\"“\\(\$0)”\""))
    }
}
