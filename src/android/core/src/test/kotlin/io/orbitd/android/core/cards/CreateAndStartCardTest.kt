package io.orbitd.android.core.cards

import io.orbitd.android.core.net.HttpMethod
import io.orbitd.android.core.protocol.Wire
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File
import java.time.Instant

/**
 * The single-task create card's second yes (task 34o9etf0IZ0t5oPbYGDz9; web `CREATE_AND_START`, `offersCreateAndStart`): Create
 * and start is offered only while the server's forecast says nothing would start the task by itself (`needsManualStart` is 1) and
 * the server marked the card `acceptsStartAfterCreate`, right after Create task and before Chat about this. It posts the card's own
 * decision with `startAfterCreate`, and Create task still posts the body it always has.
 */
class CreateAndStartCardTest {
    /** The server's forecast for one task (`TasksService`'s batch preview, a batch of one), counted under [bucket]. */
    private fun forecast(bucket: String) = buildJsonObject {
        put("taskCount", 1)
        listOf("startingNow", "blocked", "needsManualStart", "notDispatchable", "scheduled", "awaitingProjectStart").forEach {
            put(it, if (it == bucket) 1 else 0)
        }
        put("internalEdges", 0); put("externalEdges", 0)
        putJsonArray("lists") { addJsonObject { put("id", "list1"); put("title", "Backlog") } }
        putJsonArray("tasks") { addJsonObject { put("title", "Rotate the signing key") } }
    }
    private val manual get() = forecast("needsManualStart")
    /** The forecasts in which something other than a person starts the task, or nothing can. */
    private val others = listOf("startingNow", "scheduled", "blocked", "notDispatchable", "awaitingProjectStart")

    /** The body the runner will send and the server's forecast beside it; [accepts] is the server's mark that the card's runner
     * acts on the choice (`acceptsStartAfterCreate`), absent when null. */
    private fun input(preview: JsonObject?, accepts: Boolean? = true) = buildJsonObject {
        put("title", "Rotate the signing key"); put("description", "Replace the key the release job signs with.")
        put("completionCriterion", "EVIDENCE_JUDGMENT")
        preview?.let { put("preview", it) }
        accepts?.let { put("acceptsStartAfterCreate", it) }
    }
    /** The shared corpus's snapshot with this one approval in place of its own. */
    private fun card(tool: String = "orbit_task_create", preview: JsonObject? = manual, status: String = "PENDING",
        expiresAt: String? = null, accepts: Boolean? = true): InteractionCard {
        val source = fixture().obj("snapshot")!!
        val approval = buildJsonObject {
            put("id", "ct1"); put("sessionId", fixture().text("sessionId")); put("toolName", tool)
            put("input", input(preview, accepts)); put("status", status); expiresAt?.let { put("expiresAt", it) }
        }
        return cardList(JsonObject(source + ("approvals" to JsonArray(listOf(approval))))).single { it.key == "approval:ct1" }
    }
    private fun body(card: InteractionCard, verb: CardVerb) = CardRequests.build(card, verb).body!!.decodeToString()

    @Test fun offeredOnlyWhenNothingWouldStartTheTaskByItself() {
        assertTrue(ApprovalRules.offersCreateAndStart("orbit_task_create", input(manual)))
        others.forEach { assertFalse(it, ApprovalRules.offersCreateAndStart("orbit_task_create", input(forecast(it)))) }
        assertFalse("no forecast", ApprovalRules.offersCreateAndStart("orbit_task_create", input(null)))
        assertFalse("a forecast that counts no task", ApprovalRules.offersCreateAndStart("orbit_task_create", input(forecast("none"))))
        assertFalse("exactly one", ApprovalRules.offersCreateAndStart("orbit_task_create",
            input(JsonObject(manual + ("needsManualStart" to JsonPrimitive(2))))))
        listOf("orbit_project_create", "orbit_task_batch", "orbit_dag_change", "Bash").forEach {
            assertFalse(it, ApprovalRules.offersCreateAndStart(it, input(manual)))
        }
    }

    /** A card the server did not mark was filed by a runner, or through a server, that would only create the task. */
    @Test fun aCardWhoseRunnerCannotActOnItIsNotOfferedIt() {
        assertFalse("no mark", ApprovalRules.offersCreateAndStart("orbit_task_create", input(manual, accepts = null)))
        assertFalse("marked false", ApprovalRules.offersCreateAndStart("orbit_task_create", input(manual, accepts = false)))
        assertEquals(listOf(CardVerb.CREATE_TASK, CardVerb.CHAT), card(accepts = null).actions)
        assertEquals(listOf(CardVerb.CREATE_TASK, CardVerb.CHAT), card(accepts = false).actions)
        assertThrows(IllegalArgumentException::class.java) { CardRequests.build(card(accepts = null), CardVerb.CREATE_AND_START) }
        assertEquals("""{"behavior":"allow"}""", body(card(accepts = null), CardVerb.CREATE_TASK))
    }

    @Test fun itFollowsCreateTaskAndComesBeforeChat() {
        val card = card()
        assertEquals(listOf(CardVerb.CREATE_TASK, CardVerb.CREATE_AND_START, CardVerb.CHAT), card.actions)
        assertEquals("Create this task?", card.title)
    }

    @Test fun everyOtherForecastAndEveryOtherCardKeepsTheirActions() {
        others.forEach { assertEquals(it, listOf(CardVerb.CREATE_TASK, CardVerb.CHAT), card(preview = forecast(it)).actions) }
        assertEquals("no forecast", listOf(CardVerb.CREATE_TASK, CardVerb.CHAT), card(preview = null).actions)
        assertEquals(listOf(CardVerb.CREATE_PROJECT, CardVerb.CHAT), card("orbit_project_create").actions)
        assertEquals(listOf(CardVerb.CREATE_BATCH, CardVerb.CHAT), card("orbit_task_batch").actions)
        // The shared corpus's own cards, the batch among them with one task needing a manual start, offer it nowhere.
        assertEquals(1, fixture().obj("snapshot")!!.objects("approvals").single { it.text("id") == "a5" }.obj("input")!!.obj("preview")!!.number("needsManualStart"))
        cardList().forEach { assertFalse(it.key, CardVerb.CREATE_AND_START in it.actions) }
        assertEquals(listOf(CardVerb.CREATE_TASK, CardVerb.CHAT), cardList().single { it.key == "approval:a4" }.actions)
    }

    @Test fun onlyWhileTheCardIsPendingAndUnexpired() {
        listOf("ALLOWED", "DENIED", "EXPIRED").forEach { assertEquals(it, emptyList<CardVerb>(), card(status = it).actions) }
        assertEquals(emptyList<CardVerb>(), card(expiresAt = Instant.now().minusSeconds(60).toString()).actions)
        assertTrue(CardVerb.CREATE_AND_START in card(expiresAt = Instant.now().plusSeconds(600).toString()).actions)
    }

    @Test fun itPostsTheCardsDecisionWithStartAfterCreate() {
        val card = card()
        val request = CardRequests.build(card, CardVerb.CREATE_AND_START)
        assertEquals(HttpMethod.POST, request.method)
        assertEquals(listOf("sessions", fixture().text("sessionId"), "approvals", "ct1", "decision"), request.path)
        assertEquals("""{"behavior":"allow","startAfterCreate":true}""", body(card, CardVerb.CREATE_AND_START))
        assertEquals("Create and start", CardVerb.CREATE_AND_START.label)
    }

    @Test fun createTaskPostsNoStartAfterCreate() {
        val offered = card()
        assertEquals(CardRequests.build(offered, CardVerb.CREATE_AND_START).path, CardRequests.build(offered, CardVerb.CREATE_TASK).path)
        for (card in listOf(offered, card(preview = forecast("startingNow")), card(preview = null))) {
            assertEquals(card.source.toString(), """{"behavior":"allow"}""", body(card, CardVerb.CREATE_TASK))
        }
        assertEquals("Create task", CardVerb.CREATE_TASK.label)
        // Nor does any other press, on any card of the corpus.
        cardList().forEach { card -> card.actions.forEach { verb ->
            runCatching { CardRequests.build(card, verb, CardInput(text = "Why")) }.getOrNull()?.body?.decodeToString()?.let {
                assertFalse("${card.key} $verb", Wire.json.parseToJsonElement(it).jsonObject.containsKey("startAfterCreate"))
            }
        } }
    }

    @Test fun aCardThatDoesNotOfferItCannotSendIt() {
        assertThrows(IllegalArgumentException::class.java) { CardRequests.build(card(preview = forecast("startingNow")), CardVerb.CREATE_AND_START) }
        assertThrows(IllegalArgumentException::class.java) { CardRequests.build(card("orbit_project_create"), CardVerb.CREATE_AND_START) }
        assertThrows(IllegalArgumentException::class.java) { CardRequests.build(card(status = "ALLOWED"), CardVerb.CREATE_AND_START) }
    }

    /** A review records the press as its own yes once the server says ALLOWED, as it does Create task's. */
    @Test fun anAllowedPressIsThisPresssRecord() {
        val card = card()
        fun state(status: String) = CardActionState(settled = true, response = buildJsonObject { put("status", status) })
        assertEquals(CardPreviews.Phase.RECORDED, CardPreviews.phase(card, state("ALLOWED"), CardVerb.CREATE_AND_START))
        assertEquals("another end answered first", CardPreviews.Phase.CARD, CardPreviews.phase(card, state("DENIED"), CardVerb.CREATE_AND_START))
        assertEquals(CardPreviews.Phase.SENDING, CardPreviews.phase(card, CardActionState(busy = true), CardVerb.CREATE_AND_START))
    }

    /** The same words on every client: the web holds them as `CREATE_AND_START`. */
    @Test fun theWordsAreTheWebs() {
        val root = generateSequence(File(System.getProperty("user.dir")).absoluteFile) { it.parentFile }
            .first { File(it, "src/web/src/components/ApprovalPanel.tsx").isFile }
        val web = File(root, "src/web/src/components/ApprovalPanel.tsx").readText()
        assertTrue(web.contains("export const CREATE_AND_START = '${CardVerb.CREATE_AND_START.label}';"))
    }
}
