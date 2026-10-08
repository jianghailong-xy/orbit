package io.orbitd.android.wiki

import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/** What a decide's answer recorded for the op decided, as Review shows it. The server answers 200 with the changeset
 * either way; an op it could not apply carries `conflict` (the entry moved past the op's base revision, or a challenged
 * entry is no longer active) or `withdrawn`, and that is a refusal that applied nothing, never "Accepted". */
class WikiDecisionRefusalTest {
    private fun answer(vararg ops: Pair<String, String>) = buildJsonObject {
        putJsonArray("ops") { ops.forEach { (id, decision) -> addJsonObject { put("id", id); put("decision", decision) } } }
    }

    @Test fun theDecisionReadIsTheDecidedOpsOwn() {
        val answer = answer("op-1" to "accepted", "op-2" to "conflict")
        assertEquals("conflict", WikiLogic.recordedDecision(answer, "op-2"))
        assertEquals("accepted", WikiLogic.recordedDecision(answer, "op-1"))
        assertNull("an op the answer does not hold", WikiLogic.recordedDecision(answer, "op-3"))
        assertNull("an answer without ops", WikiLogic.recordedDecision(JsonObject(emptyMap()), "op-1"))
        val uuid = "0196b500-0000-7000-8000-000000000093"
        assertEquals("the answer's UUID and the card's public id name the same op", "conflict",
            WikiLogic.recordedDecision(answer(uuid to "conflict"), wikiPublicId(uuid)))
    }

    @Test fun aConflictOrAWithdrawalIsARefusalThatAppliedNothing() {
        listOf("amend", "supersede", "retire", "add").forEach { op ->
            assertEquals("a stale $op", WikiCopy.conflictRefused, WikiLogic.decisionRefusal("conflict", op, "accept"))
        }
        assertEquals("a challenge of an entry no longer active", WikiCopy.inactiveRefused, WikiLogic.decisionRefusal("conflict", "challenge", "reconfirm"))
        assertEquals(WikiCopy.inactiveRefused, WikiLogic.decisionRefusal("conflict", "challenge", "retire"))
        assertEquals(WikiCopy.withdrawnRefused, WikiLogic.decisionRefusal("withdrawn", "amend", "accept"))
        listOf("accepted", "edited", "rejected", "auto_applied", "pending", "verifying", null).forEach { decision ->
            assertNull("$decision is no refusal", WikiLogic.decisionRefusal(decision, "challenge", "reconfirm"))
        }
    }

    /** Retire on a challenge withdraws every op still waiting on the entry, the challenge included: recorded
     * `withdrawn`, it is the Retire done, said "Retired". Any other answer recorded `withdrawn` applied nothing. */
    @Test fun aChallengesRetireRecordedWithdrawnIsTheRetireDone() {
        assertNull(WikiLogic.decisionRefusal("withdrawn", "challenge", "retire"))
        assertEquals(WikiCopy.retired, WikiLogic.decidedToast("challenge", "retire"))
        listOf("reconfirm", "amend").forEach { action ->
            assertEquals("a challenge's $action", WikiCopy.withdrawnRefused, WikiLogic.decisionRefusal("withdrawn", "challenge", action))
        }
        assertEquals("an accepted retire proposal", WikiCopy.withdrawnRefused, WikiLogic.decisionRefusal("withdrawn", "retire", "accept"))
    }
}
