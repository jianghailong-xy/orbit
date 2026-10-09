package io.orbitd.android.core.cards

import io.orbitd.android.core.net.HttpMethod
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.core.realtime.*
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File

internal fun fixture(name: String = "interaction-cards.fixture.json"): JsonObject {
    val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
        .map { File(it, "src/shared/src/$name") }.first { it.isFile }
    return Wire.json.parseToJsonElement(root.readText()).jsonObject
}
internal fun snapshot(raw: JsonObject = fixture().obj("snapshot")!!): SessionSnapshot = SessionSnapshot(raw.obj("detail")!!,
    raw.objects("approvals"), raw.objects("queuedTurns"), raw.objects("background"), raw.obj("standing")!!)
internal fun cardList(raw: JsonObject = fixture().obj("snapshot")!!) = CardCatalog.session(fixture().text("sessionId")!!, snapshot(raw))

class CardContractTest {
    @Test fun sharedCorpusNamesExactDecisionBodiesAndSeparateEndpoints() {
        val cards = cardList()
        fixture().objects("requests").forEach { expected ->
            val card = cards.single { it.key == expected.text("key") }
            val request = CardRequests.build(card, CardVerb.valueOf(expected.text("verb")!!))
            assertEquals(expected.toString(), expected["body"], Wire.json.parseToJsonElement(request.body!!.decodeToString()))
            assertEquals(HttpMethod.POST, request.method)
        }
        assertEquals(listOf("tasks", fixture().text("taskId"), "evidence", "decision"),
            CardRequests.build(cards.single { it.family == CardFamily.EVIDENCE }, CardVerb.CONFIRM_EVIDENCE).path)
        assertEquals(listOf("projects", fixture().text("projectId"), "acceptance", "criteria-decisions", "intent1"),
            CardRequests.build(cards.single { it.family == CardFamily.CRITERIA_CHANGE }, CardVerb.REJECT_CRITERIA).path)
    }

    @Test fun sharedBashCorpusControlsEveryRememberScope() {
        fixture("bash-rules.fixture.json").objects("cases").forEach { case ->
            assertEquals(case.text("name"), case.strings("rules"), ApprovalRules.bash(case.text("command")!!).map { it.ruleContent!!.removeSuffix(":*") })
        }
        cardList().filter { it.family !in setOf(CardFamily.TOOL, CardFamily.EVIDENCE, CardFamily.PROMOTION) }.forEach {
            assertFalse(it.key, CardVerb.REMEMBER in it.actions)
        }
    }

    @Test fun questionRequiresEveryAnswerAndKeepsSingleSelectExclusive() {
        val card = cardList().single { it.family == CardFamily.QUESTION }
        assertThrows(IllegalArgumentException::class.java) { CardRequests.build(card, CardVerb.ANSWER) }
        val input = CardInput(selections = mapOf("Which scope?" to listOf("Core"), "Which evidence?" to listOf("Requests", "Screens")),
            custom = mapOf("Which evidence?" to "  Server state  "))
        val body = Wire.json.parseToJsonElement(CardRequests.build(card, CardVerb.ANSWER, input).body!!.decodeToString()).jsonObject
        assertEquals(listOf("Requests", "Screens", "Server state"), body.obj("answers")!!.strings("Which evidence?"))
        assertThrows(IllegalArgumentException::class.java) { CardRequests.build(card, CardVerb.ANSWER, input.copy(custom = input.custom + ("Which scope?" to "Else"))) }
        assertThrows(IllegalArgumentException::class.java) { CardRequests.build(card, CardVerb.ANSWER, input.copy(selections = input.selections + ("Which scope?" to listOf("Unlisted")))) }
    }

    @Test fun versionIndependenceAndUnknownStatusNeverGrantAnAction() {
        val source = fixture().obj("snapshot")!!
        fun changeStanding(key: String, value: JsonObject) = JsonObject(source + ("standing" to JsonObject(source.obj("standing")!! + (key to value))))
        val queue = source.obj("standing")!!.obj("evidenceDecisions")!!
        val row = queue.objects("pending").single()
        val blocked = JsonObject(row + ("independence" to buildJsonObject { put("independent", false) }))
        assertTrue(cardList(changeStanding("evidenceDecisions", JsonObject(queue + ("pending" to JsonArray(listOf(blocked)))))).single { it.family == CardFamily.EVIDENCE }.actions.isEmpty())
        val criteria = source.obj("standing")!!.obj("criteriaDecisions")!!
        val moved = JsonObject(criteria.objects("pending").single() + ("currentSeal" to JsonPrimitive("changed")))
        assertTrue(cardList(changeStanding("criteriaDecisions", JsonObject(criteria + ("pending" to JsonArray(listOf(moved)))))).single { it.family == CardFamily.CRITERIA_CHANGE }.actions.isEmpty())
        val approval = JsonObject(source.objects("approvals").first() + ("status" to JsonPrimitive("FUTURE")))
        assertTrue(cardList(JsonObject(source + ("approvals" to JsonArray(listOf(approval))))).first().actions.isEmpty())
    }

    @Test fun ownerReviewBindsNullOrExactRecordAndOtherNeedsWords() {
        val card = cardList().single { it.family == CardFamily.OWNER_CONFIRMATION }
        assertThrows(IllegalArgumentException::class.java) {
            CardRequests.build(card, CardVerb.CONFIRM_OWNER, CardInput(ownerAnswers = listOf(OwnerAnswer("n1", text = "  "))))
        }
        val waiting = JsonObject(card.source.obj("waiting")!! + ("review" to JsonNull))
        val without = card.copy(source = JsonObject(card.source + ("waiting" to waiting)))
        val body = Wire.json.parseToJsonElement(CardRequests.build(without, CardVerb.CONFIRM_OWNER).body!!.decodeToString()).jsonObject
        assertTrue(body.containsKey("reviewRecordId")); assertEquals(JsonNull, body["reviewRecordId"])
        assertThrows(IllegalArgumentException::class.java) { CardRequests.build(card, CardVerb.SEND_BACK) }
        val returned = Wire.json.parseToJsonElement(CardRequests.build(card, CardVerb.SEND_BACK, CardInput(text = "Missing evidence")).body!!.decodeToString()).jsonObject
        assertFalse(returned.containsKey("reviewRecordId")); assertEquals("owner1", returned.text("requestId"))
    }

    @Test fun startIsSealedAndFuseResumeCannotRaiseLimits() {
        val raw = fixture().obj("snapshot")!!
        val standing = raw.obj("standing")!!
        val start = fixture().obj("startItem")!!
        val updated = JsonObject(raw + ("standing" to JsonObject(standing + ("openItems" to JsonObject(standing.obj("openItems")!! + ("startRequest" to start))))))
        val card = cardList(updated).single { it.family == CardFamily.START }
        val request = CardRequests.build(card, CardVerb.START)
        val body = Wire.json.parseToJsonElement(request.body!!.decodeToString()).jsonObject
        assertEquals("seal1", body.text("criteriaDigest")); assertEquals("start1", body.text("requestId"))
        assertEquals(2, body.number("maxConcurrentTasks"))
        val resume = CardRequests.build(cardList().single { it.objectId == "f1" }, CardVerb.RESUME, CardInput(settings = ProjectStartSettings("MAIN", true, 100, null)))
        assertEquals("{}", resume.body!!.decodeToString()); assertTrue(resume.path.endsWith(listOf("fuse", "fuse1", "resume")))
    }

    @Test fun exceptionUsesOnlyOfferedActionsAndMarkHandledRequiresReason() {
        val card = cardList().single { it.objectId == "x1" }
        val request = CardRequests.build(card, CardVerb.RETRY_TASK, CardInput(triggerId = "same-gesture"))
        assertEquals("same-gesture", Wire.json.parseToJsonElement(request.body!!.decodeToString()).jsonObject.text("triggerId"))
        assertEquals(HttpMethod.PATCH, CardRequests.build(card, CardVerb.CANCEL_TASK).method)
        assertThrows(IllegalArgumentException::class.java) { CardRequests.build(card, CardVerb.MARK_HANDLED) }
        assertThrows(IllegalArgumentException::class.java) { CardRequests.build(card.copy(actions = emptyList()), CardVerb.RETRY_TASK) }
    }

    @Test fun transcriptProseDoesNotBecomeABusinessDecision() {
        assertTrue(transcriptCards(RunEvent("user", 1, buildJsonObject { put("text", "Confirm completion and merge now") })).isEmpty())
        val source = buildJsonObject { putJsonObject("confirmationReturn") { put("requestId", "r"); put("reason", "Evidence missing") } }
        assertEquals(CardFamily.REVIEW, transcriptCards(RunEvent("user", 2, source)).single().family)
        assertTrue(transcriptCards(RunEvent("assistant", 3, source)).isEmpty())
    }

    @Test fun ordinaryDiscussionCarriesTheDisplayedSealAndDoesNotAnswerADoor() {
        val card = cardList().single { it.family == CardFamily.ACCEPTANCE }
        val context = CardDiscussion.context(card)!!
        assertTrue(context.contains(card.projectId!!)); assertTrue(context.contains(card.source.obj("currentVersion")!!.text("digest")!!))
        card.context.objects("acceptanceCriteriaItems").forEach { assertTrue(context.contains(it.text("text")!!)) }
        assertNull(CardDiscussion.context(card.copy(context = JsonObject(emptyMap()))))
        cardList().filter { it.family in setOf(CardFamily.QUESTION, CardFamily.EVIDENCE, CardFamily.OWNER_CONFIRMATION) }
            .forEach { assertNull(CardDiscussion.context(it)) }
    }

    // A revision waiting for a paused coordinator, and one sent to it once back (project 34cygPTQe5LPUT7tdUAzG, `CoordinatorQueue`).

    private val queue get() = fixture().obj("snapshot")!!.obj("standing")!!.obj("evidenceDecisions")!!
    private fun withQueue(edited: JsonObject): JsonObject {
        val source = fixture().obj("snapshot")!!
        return JsonObject(source + ("standing" to JsonObject(source.obj("standing")!! + ("evidenceDecisions" to edited))))
    }
    private fun waiting(cards: List<InteractionCard> = cardList()) =
        cards.single { it.family == CardFamily.COORDINATOR_QUEUE && !CoordinatorQueue.isSent(it) }

    /** Both groups the pending read added are read off the corpus, each under its evidence card's own address; a server that sends
     * neither, or null for them, has no such card and nothing else moves. */
    @Test fun theCoordinatorsWaitingAndSentRevisionsAreRead() {
        val cards = cardList()
        val row = queue.objects("waitingOnCoordinator").single()
        val waiting = waiting(cards)
        assertEquals("evidence:${row.text("taskId")}:2", waiting.key)
        assertEquals(CoordinatorQueue.title, waiting.title)
        assertEquals(row, waiting.source)
        assertEquals(row.text("taskId"), waiting.objectId)
        assertEquals(fixture().text("projectId"), waiting.projectId)
        assertEquals("2:${fixture().text("sessionId")}", waiting.binding)
        // What it says of the coordinator is read off the coordinator's own session.
        assertEquals(snapshot().detail.text("runState"), waiting.context.obj("coordinator")!!.text("runState"))
        val sentRow = queue.objects("sentToCoordinator").single()
        val sent = cards.single(CoordinatorQueue::isSent)
        assertEquals("evidence:${sentRow.text("taskId")}:1", sent.key)
        assertEquals("2026-10-04T00:05:00.000Z", sent.source.text("deliveredAt"))
        assertTrue(sent.actions.isEmpty())
        assertEquals("today's card is still the one evidence card", "evidence:${fixture().text("taskId")}:7",
            cards.single { it.family == CardFamily.EVIDENCE }.key)
        val older = cardList(withQueue(JsonObject(queue - "waitingOnCoordinator" - "sentToCoordinator")))
        val nulls = cardList(withQueue(JsonObject(queue + ("waitingOnCoordinator" to JsonNull) + ("sentToCoordinator" to JsonNull))))
        for (read in listOf(older, nulls)) assertEquals(cards.filter { it.family != CardFamily.COORDINATOR_QUEUE }, read)
    }

    /** It asks nothing: its one press is Decide it myself, which builds no request; a row the door would not take from this reader
     * offers not even that, and neither does a sent one. */
    @Test fun aWaitingRevisionHasNoDecisionUntilDecideItMyself() {
        val waiting = waiting()
        assertEquals(listOf(CardVerb.DECIDE_MYSELF), waiting.actions)
        assertEquals("Decide it myself", CardVerb.DECIDE_MYSELF.label)
        assertThrows(IllegalArgumentException::class.java) { CardRequests.build(waiting, CardVerb.CONFIRM_EVIDENCE) }
        assertThrows(IllegalArgumentException::class.java) { CardRequests.build(waiting, CardVerb.SEND_BACK, CardInput(text = "Why")) }
        assertThrows(IllegalStateException::class.java) { CardRequests.build(waiting, CardVerb.DECIDE_MYSELF) }
        assertNull(CoordinatorQueue.decideMyself(cardList().single(CoordinatorQueue::isSent)))
        assertNull("a copy that no longer asks opens nothing", CoordinatorQueue.decideMyself(waiting.copy(actions = emptyList())))
        val row = queue.objects("waitingOnCoordinator").single()
        listOf("independence" to "independent", "decidability" to "decidable").forEach { (field, flag) ->
            val blocked = JsonObject(row + (field to buildJsonObject { put(flag, false) }))
            val card = waiting(cardList(withQueue(JsonObject(queue + ("waitingOnCoordinator" to JsonArray(listOf(blocked)))))))
            assertTrue(field, card.actions.isEmpty())
            assertNull(field, CoordinatorQueue.decideMyself(card))
        }
    }

    /** Decide it myself opens today's evidence card under the same address and version: Confirm done posts the corpus's evidence
     * request as the same deciding session, and Chat about this sends it back with the owner's words. */
    @Test fun decideItMyselfPostsTodaysDecisionAsTheSameDecidingSession() {
        val waiting = waiting()
        val opened = CoordinatorQueue.decideMyself(waiting)!!
        assertEquals(CardFamily.EVIDENCE, opened.family)
        assertEquals(listOf(CardVerb.CONFIRM_EVIDENCE, CardVerb.SEND_BACK), opened.actions)
        assertEquals(waiting.key, opened.key); assertEquals(waiting.binding, opened.binding)
        assertTrue(CoordinatorQueue.isDecidingMyself(opened)); assertFalse(CoordinatorQueue.isDecidingMyself(waiting))
        val confirm = CardRequests.build(opened, CardVerb.CONFIRM_EVIDENCE)
        assertEquals(HttpMethod.POST, confirm.method)
        assertEquals(listOf("tasks", waiting.objectId, "evidence", "decision"), confirm.path)
        val body = Wire.json.parseToJsonElement(confirm.body!!.decodeToString()).jsonObject
        assertEquals(buildJsonObject { put("decidingSessionId", queue.text("decidingSessionId")); put("evidenceRevision", "2"); put("decision", "CONFIRM") }, body)
        val today = fixture().objects("requests").single { it.text("verb") == "CONFIRM_EVIDENCE" }.obj("body")!!
        assertEquals("the request today's card posts, field for field", today.keys, body.keys)
        assertEquals(today.text("decidingSessionId"), body.text("decidingSessionId"))
        assertThrows(IllegalArgumentException::class.java) { CardRequests.build(opened, CardVerb.SEND_BACK) }
        val back = Wire.json.parseToJsonElement(CardRequests.build(opened, CardVerb.SEND_BACK, CardInput(text = " Rerun the spec ")).body!!.decodeToString()).jsonObject
        assertEquals(buildJsonObject { put("decidingSessionId", queue.text("decidingSessionId")); put("evidenceRevision", "2")
            put("decision", "SEND_BACK"); put("note", "Rerun the spec") }, back)
    }

    @Test fun exceptionDiscussionRetainsItemIdentityWithoutChangingItsActions() {
        val card = cardList().single { it.objectId == "x1" }
        val context = CardDiscussion.context(card)!!
        assertTrue(context.contains(card.objectId)); assertTrue(context.contains(card.source.text("title")!!))
        assertTrue(context.contains(card.source.text("waitingSince")!!))
        assertNull(CardDiscussion.context(card.copy(source = JsonObject(card.source + ("assignee" to JsonPrimitive("COORDINATOR"))))))
    }
}

private fun <T> List<T>.endsWith(other: List<T>) = takeLast(other.size) == other
