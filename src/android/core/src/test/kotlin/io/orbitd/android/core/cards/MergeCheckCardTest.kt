package io.orbitd.android.core.cards

import io.orbitd.android.core.protocol.Wire
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/**
 * A08-8 (iOS 9b5f02d9b): a session's proposal to change its project's merge check is answered on the owner's card, and only
 * on a card a PERSON answered — so it offers no "Allow & remember", and saying no is "Chat about this", as on Orbit's
 * other asks (OrbitKit `Approvals.isOrbitAsk`, OrbitAskPreviewTests).
 */
class MergeCheckCardTest {
    private val input = buildJsonObject {
        put("projectId", "34ZZn8fmemArxvl2CsCFp")
        putJsonObject("integration") { put("mergeCheckCommand", "npm test") }
    }
    private fun card(): InteractionCard {
        val source = fixture().obj("snapshot")!!
        val approval = buildJsonObject {
            put("id", "mc1"); put("sessionId", fixture().text("sessionId")); put("toolName", "orbit_project_update_integration")
            put("input", input); put("status", "PENDING")
        }
        return cardList(JsonObject(source + ("approvals" to JsonArray(listOf(approval))))).single { it.key == "approval:mc1" }
    }

    @Test fun aMergeCheckChangeHasNoStandingYes() {
        assertEquals(emptyList<PermissionRule>(), ApprovalRules.remember("orbit_project_update_integration", input))
        assertFalse(CardVerb.REMEMBER in card().actions)
    }

    @Test fun sayingNoToAMergeCheckChangeIsAConversation() {
        val card = card()
        assertEquals(listOf(CardVerb.ALLOW, CardVerb.CHAT), card.actions)
        val refusal = Wire.json.parseToJsonElement(CardRequests.build(card, CardVerb.CHAT, CardInput("Keep the full gate")).body!!.decodeToString()).jsonObject
        assertEquals("deny", refusal.text("behavior"))
        assertEquals("Keep the full gate", refusal.text("message"))
        assertNull(refusal["rememberRules"])
        val allowed = Wire.json.parseToJsonElement(CardRequests.build(card, CardVerb.ALLOW).body!!.decodeToString()).jsonObject
        assertEquals("allow", allowed.text("behavior"))
        assertEquals(listOf("sessions", fixture().text("sessionId"), "approvals", "mc1", "decision"), CardRequests.build(card, CardVerb.ALLOW).path)
    }

    /** Every other tool keeps its Deny and, where a rule can be drawn, its remember. */
    @Test fun anOrdinaryToolKeepsDenyAndRemember() {
        val bash = cardList().single { it.key == "approval:a1" }
        assertEquals(listOf(CardVerb.ALLOW, CardVerb.DENY, CardVerb.REMEMBER), bash.actions)
    }
}
