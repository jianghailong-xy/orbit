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

    @Test fun createdTaskSentenceIsDrivenBySharedFixture() {
        fixture("session-created-tasks.fixture.json").objects("countLine").forEach { row ->
            assertEquals(row.text("text"), createdTasksCountLine(row))
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

    @Test fun exceptionDiscussionRetainsItemIdentityWithoutChangingItsActions() {
        val card = cardList().single { it.objectId == "x1" }
        val context = CardDiscussion.context(card)!!
        assertTrue(context.contains(card.objectId)); assertTrue(context.contains(card.source.text("title")!!))
        assertTrue(context.contains(card.source.text("waitingSince")!!))
        assertNull(CardDiscussion.context(card.copy(source = JsonObject(card.source + ("assignee" to JsonPrimitive("COORDINATOR"))))))
    }
}

private fun <T> List<T>.endsWith(other: List<T>) = takeLast(other.size) == other
