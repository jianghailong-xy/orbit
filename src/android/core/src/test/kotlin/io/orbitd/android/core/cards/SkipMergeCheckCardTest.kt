package io.orbitd.android.core.cards

import io.orbitd.android.core.protocol.Wire
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/**
 * A session's ask to land one task without its project's merge check (iOS ce42abc42, web `SkipMergeCheckBody`): one of Orbit's
 * own asks, so no "Allow & remember" and saying no is "Chat about this", and its body is read off the runner's flat input
 * (`runner-go/mcp.go` `skipMergeCheckFacts`).
 */
class SkipMergeCheckCardTest {
    private fun input(json: String) = Wire.json.parseToJsonElement(json).jsonObject
    private val full = input("""
        {"projectId":"34vCfW","projectTitle":"Payments","taskId":"34vD","taskTitle":"Fix the refund rounding",
         "checkCommand":"npm ci && npm test","failure":"3 tests failed in ledger.spec.ts",
         "generation":"2","reason":"The ledger spec is **flaky** on main too.",
         "mainBranch":"refs/heads/release"}
    """)
    private val bare = input("""{"projectTitle":"","taskTitle":"","checkCommand":"make check","mainBranch":null}""")

    private fun card(input: JsonObject = full): InteractionCard {
        val source = fixture().obj("snapshot")!!
        val approval = buildJsonObject {
            put("id", "sk1"); put("sessionId", fixture().text("sessionId")); put("toolName", SkipMergeCheckCards.tool)
            put("input", input); put("status", "PENDING")
        }
        return cardList(JsonObject(source + ("approvals" to JsonArray(listOf(approval))))).single { it.key == "approval:sk1" }
    }

    @Test fun aSkipHasNoStandingYes() {
        assertEquals(emptyList<PermissionRule>(), ApprovalRules.remember("orbit_integration_skip_merge_check", full))
        assertFalse(CardVerb.REMEMBER in card().actions)
    }

    @Test fun sayingNoToASkipIsAConversation() {
        val card = card()
        assertEquals(listOf(CardVerb.ALLOW, CardVerb.CHAT), card.actions)
        assertEquals("Land without the check?", card.title)
        val refusal = Wire.json.parseToJsonElement(CardRequests.build(card, CardVerb.CHAT, CardInput("Fix the spec first")).body!!.decodeToString()).jsonObject
        assertEquals("deny", refusal.text("behavior"))
        assertEquals("Fix the spec first", refusal.text("message"))
        assertNull(refusal["rememberRules"])
        val allowed = Wire.json.parseToJsonElement(CardRequests.build(card, CardVerb.ALLOW).body!!.decodeToString()).jsonObject
        assertEquals("allow", allowed.text("behavior"))
    }

    @Test fun aSkipShowsTheTaskTheCommandAndTheReason() {
        val skip = SkipMergeCheckCards.read(card().source.obj("input")!!)
        assertEquals("Fix the refund rounding", skip.taskLine)
        assertEquals("In Payments", skip.projectLine)
        assertEquals("npm ci && npm test", skip.checkCommand)
        assertEquals("3 tests failed in ledger.spec.ts", skip.failure)
        assertEquals("The ledger spec is **flaky** on main too.", skip.reason)
        assertEquals("release", skip.mainBranch)
        assertEquals("Once, and only this landing: the project’s check command is unchanged, and the next landing and every merge " +
            "into release are checked as before.", skip.note)
        assertEquals("Fix the refund rounding", skip.declineName)
        assertEquals("Land it without the check", SkipMergeCheckCards.action)
        assertEquals("This landing runs without the merge check", SkipMergeCheckCards.commandCaption)
        assertEquals("The agent says this red is the check’s, not the work’s", SkipMergeCheckCards.reasonCaption)
    }

    @Test fun aSkipWithNoNamesOrBranchSaysSoInWords() {
        val card = card(bare)
        assertEquals(listOf(CardVerb.ALLOW, CardVerb.CHAT), card.actions)
        val skip = SkipMergeCheckCards.read(card.source.obj("input")!!)
        assertEquals("This task", skip.taskLine)
        assertNull(skip.projectLine)
        assertEquals("make check", skip.checkCommand)
        assertEquals("", skip.failure)
        assertEquals("", skip.reason)
        assertEquals("main", skip.mainBranch)
        assertTrue(skip.note.endsWith("every merge into main are checked as before."))
        assertEquals("this landing", skip.declineName)
    }
}
