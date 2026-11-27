package io.orbitd.android.core.cards

import io.orbitd.android.core.protocol.Wire
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/**
 * A07-5 (iOS cef6c8e0d, OrbitKit DshRuntimeTests.testApprovalRememberIsNotOfferedOnHarness): DeepSeek Harness's approval bridge
 * answers each ask once — allow-once or reject-once — and drops remember rules, so a card in a Harness session offers Allow and Deny
 * alone, and nothing it sends carries a rule. A session on any other engine keeps "Allow & remember".
 */
class DshApprovalCardTest {
    @Test fun aScheduledCheckRemembersOnlyTheExactCommand() {
        val command = """python3 -c "print(open('watched.txt').read())" """.trimEnd()
        val input = buildJsonObject { put("command", command); put("orbitScheduleCheckOnly", true) }
        assertEquals(listOf(PermissionRule("Bash", command)), ApprovalRules.remember("Bash", input))
        // An ordinary card remembers prefixes, and none for an interpreter: python3:* would cover every script.
        assertEquals(listOf(PermissionRule("Bash", "psql:*")), ApprovalRules.remember("Bash", buildJsonObject { put("command", "psql -c \"select 1\" db") }))
        assertEquals(emptyList<PermissionRule>(), ApprovalRules.remember("Bash", buildJsonObject { put("command", command) }))
    }

    private val raw = fixture().obj("snapshot")!!
    /** The shared corpus's snapshot, on the engine the server says the session runs on. */
    private fun on(engine: String) = JsonObject(raw + ("detail" to JsonObject(raw.obj("detail")!! + ("engine" to JsonPrimitive(engine)))))
    private fun bash(snapshot: JsonObject) = cardList(snapshot).single { it.key == "approval:a1" }

    @Test fun aHarnessSessionsToolCardIsAllowAndDenyAlone() {
        val card = bash(on("dsh"))
        assertEquals(listOf(CardVerb.ALLOW, CardVerb.DENY), card.actions)
        val allowed = Wire.json.parseToJsonElement(CardRequests.build(card, CardVerb.ALLOW).body!!.decodeToString()).jsonObject
        assertEquals("allow", allowed.text("behavior"))
        assertNull("no rule rides along", allowed["rememberRules"])
    }

    @Test fun everyOtherEngineKeepsAllowAndRemember() {
        for (engine in listOf("claude", "codex", "kimi", "opencode", "antigravity")) {
            assertEquals(engine, listOf(CardVerb.ALLOW, CardVerb.DENY, CardVerb.REMEMBER), bash(on(engine)).actions)
        }
        assertEquals("a server that doesn't say the engine", listOf(CardVerb.ALLOW, CardVerb.DENY, CardVerb.REMEMBER), bash(raw).actions)
    }
}
