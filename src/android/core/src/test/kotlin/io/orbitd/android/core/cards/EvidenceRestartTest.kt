package io.orbitd.android.core.cards

import io.orbitd.android.core.net.HttpMethod
import io.orbitd.android.core.protocol.Wire
import io.orbitd.android.core.realtime.SessionSnapshot
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/**
 * Restart the task on the owner's evidence card (docs/evidence-always-has-an-addressee-design.md §3, D2 = A): the pending-evidence
 * row's `ownerAction` read with and without it, the press it makes, its refusals, and its words held to the copy table the web and
 * OrbitKit are proved against (`src/shared/src/evidence-restart-copy.fixture.json`). A missing table is a failure, never a skip.
 */
class EvidenceRestartTest {
    private val session = "s-owner"

    /** A row as `readPendingEvidenceJudgments` writes an undecidable one: the standard moved, nobody else can move it. */
    private fun row(ownerAction: JsonElement? = JsonPrimitive("RESTART_TASK"), addressee: String = "OWNER") = buildJsonObject {
        put("taskId", "t-1"); put("title", "Wire the card"); put("projectId", "p-1"); put("ownerCard", JsonNull)
        putJsonObject("criterion") { put("key", "k"); put("text", "The card offers Restart the task.") }
        put("evidenceRevision", "3"); put("ageSeconds", 60); put("claim", "Done."); putJsonArray("gaps") {}; putJsonArray("citations") {}
        putJsonObject("decidability") {
            put("decidable", false); put("refusal", "the criterion was reworded after this revision was submitted")
            put("requiredAction", "RESUBMIT_AGAINST_THE_CURRENT_CRITERION"); put("addressee", addressee)
        }
        putJsonObject("independence") { put("independent", true); put("disqualification", JsonNull); put("requiredAction", JsonNull) }
        if (ownerAction != null) put("ownerAction", ownerAction)
    }

    private fun cards(waiting: List<JsonObject>, pending: List<JsonObject> = emptyList()) = CardCatalog.session(session, SessionSnapshot(
        buildJsonObject { put("id", session); put("projectId", "p-1") }, emptyList(), emptyList(), emptyList(),
        mapOf("evidenceDecisions" to buildJsonObject {
            put("decidingSessionId", session); put("count", pending.size)
            put("pending", JsonArray(pending)); put("waitingOnYou", JsonArray(waiting))
            putJsonArray("sentToCoordinator") {}; putJsonArray("decided") {}
        })))

    @Test fun aRowCarryingTheActionIsTheOwnersCardWithRestartTheTask() {
        val card = cards(listOf(row())).single()
        assertEquals("evidence:t-1:3", card.key)
        assertEquals(CardFamily.EVIDENCE, card.family)
        assertEquals(listOf(CardVerb.RESTART_TASK), card.actions)
        assertEquals("Restart the task", CardVerb.RESTART_TASK.label)
        assertTrue(EvidenceRestart.offered(card.source))
    }

    @Test fun aRowWithoutTheFieldOffersNothing() {
        // Absent (an older server, or a row nobody else is waiting on), null, and a word this client does not know all read as no action.
        listOf(null, JsonNull, JsonPrimitive("SOMETHING_NEW")).forEach { action ->
            assertTrue("$action", cards(listOf(row(action))).isEmpty())
            assertFalse("$action", EvidenceRestart.offered(row(action)))
        }
        // A run's own row (it was steered) is not the owner's to press.
        assertTrue(cards(listOf(row(null, addressee = "RUN"))).isEmpty())
    }

    @Test fun aDecidablePendingRowIsReadAsBefore() {
        val decidable = JsonObject(row(null) + ("decidability" to buildJsonObject {
            put("decidable", true); put("refusal", JsonNull); put("requiredAction", JsonNull); put("addressee", JsonNull) }))
        val card = cards(emptyList(), listOf(decidable)).single()
        assertEquals(listOf(CardVerb.CONFIRM_EVIDENCE, CardVerb.SEND_BACK), card.actions)
        assertFalse(EvidenceRestart.offered(card.source))
    }

    @Test fun thePressIsTheRestartDoorWithTheRunPressName() {
        val card = cards(listOf(row())).single()
        val request = CardRequests.build(card, CardVerb.RESTART_TASK, CardInput(triggerId = "0198f0a0-0000-7000-8000-000000000001"))
        assertEquals(HttpMethod.POST, request.method)
        assertEquals(listOf("tasks", "t-1", "evidence", "3", "restart"), request.path)
        assertEquals(buildJsonObject { put("triggerId", "0198f0a0-0000-7000-8000-000000000001") },
            Wire.json.parseToJsonElement(request.body!!.decodeToString()))
        // Without its name the press does not go out; and it is no verb of any other card.
        assertThrows(IllegalArgumentException::class.java) { CardRequests.build(card, CardVerb.RESTART_TASK) }
        assertThrows(IllegalArgumentException::class.java) { CardRequests.build(card, CardVerb.CONFIRM_EVIDENCE) }
    }

    @Test fun aRefusalSaysOutOfDateOnlyForTheServersCode() {
        assertEquals("Not restarted: this row is out of date", EvidenceRestart.refusalTitle("EVIDENCE_RESTART_NOT_OFFERED"))
        assertEquals("Not restarted", EvidenceRestart.refusalTitle("TASK_ALREADY_RUNNING"))
        assertEquals("Not restarted", EvidenceRestart.refusalTitle(null))
    }

    @Test fun everyWordIsTheSharedCopyTable() {
        val table = fixture("evidence-restart-copy.fixture.json")
        assertEquals(table.text("ownerAction"), EvidenceRestart.ownerAction)
        assertEquals(table.text("refusalCode"), EvidenceRestart.refusalCode)
        val copy = requireNotNull(table.obj("copy")) { "the copy table has no copy" }
        mapOf("action" to EvidenceRestart.action, "explanation" to EvidenceRestart.explanation, "started" to EvidenceRestart.started,
            "refused" to EvidenceRestart.refused, "stale" to EvidenceRestart.stale).forEach { (name, value) ->
            assertEquals(name, copy.text(name), value)
        }
        assertEquals("every word of the table is held here", setOf("action", "explanation", "started", "refused", "stale"), copy.keys)
        assertEquals(copy.text("action"), CardVerb.RESTART_TASK.label)
    }
}
