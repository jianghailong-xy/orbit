package io.orbitd.android.core.cards

import io.orbitd.android.core.protocol.Wire
import java.io.File
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/**
 * A session's delete of a runner or a workspace, asked on the owner's card (OrbitKit `DeleteApprovalPreview`, web `DeleteBody`): the
 * card reads what the server filed, its yes says what it does, there is no standing yes, and saying no is "Chat about this".
 */
class DeleteCardTest {
    private val runner = buildJsonObject {
        put("runnerId", "r1"); put("name", "instance-20261027-071926"); put("displayName", JsonNull); put("online", false)
        put("lastHeartbeatAt", "2026-10-28T05:46:18.109Z")
        putJsonArray("workspaces") {
            addJsonObject { put("id", "w1"); put("name", "c2b-loadtest"); put("workDir", JsonNull) }
            addJsonObject { put("id", "w2"); put("name", "site"); put("workDir", "~/site") }
        }
    }
    private val workspace = buildJsonObject {
        put("agentId", "w1"); put("name", "c2b-loadtest"); put("workDir", "/srv/loadtest")
        putJsonObject("runner") { put("id", "r1"); put("name", "workstation-gpu"); put("displayName", "HPC") }
    }
    private fun card(tool: String, input: JsonObject): InteractionCard {
        val source = fixture().obj("snapshot")!!
        val approval = buildJsonObject {
            put("id", "d1"); put("sessionId", fixture().text("sessionId")); put("toolName", tool); put("input", input); put("status", "PENDING")
        }
        return cardList(JsonObject(source + ("approvals" to JsonArray(listOf(approval))))).single { it.key == "approval:d1" }
    }
    private fun decision(card: InteractionCard, verb: CardVerb, input: CardInput = CardInput()): JsonObject {
        val request = CardRequests.build(card, verb, input)
        assertEquals(listOf("sessions", card.sessionId, "approvals", "d1", "decision"), request.path)
        return Wire.json.parseToJsonElement(request.body!!.decodeToString()).jsonObject
    }

    @Test fun bothDeletesAreOneFamilyWithTheirOwnHeading() {
        assertEquals(CardFamily.DELETE, approvalFamily("orbit_runner_delete"))
        assertEquals(CardFamily.DELETE, approvalFamily("orbit_agent_delete"))
        assertEquals("Delete this runner?", card(DeleteCards.runnerTool, runner).title)
        assertEquals("Delete this workspace?", card(DeleteCards.workspaceTool, workspace).title)
        assertNotEquals("a provider's delete is the provider's card", CardFamily.DELETE, approvalFamily("orbit_provider_delete"))
    }

    @Test fun aDeleteStaysWholeInTheConversationWithNoStandingYes() {
        listOf(DeleteCards.runnerTool to runner, DeleteCards.workspaceTool to workspace).forEach { (tool, input) ->
            val card = card(tool, input)
            assertEquals(listOf(CardVerb.DELETE_IT, CardVerb.CHAT), card.actions)
            assertEquals("Delete it", CardVerb.DELETE_IT.label)
            assertNull(CardPreviews.preview(card))
            assertEquals(emptyList<PermissionRule>(), ApprovalRules.remember(tool, input))
        }
    }

    @Test fun theYesIsAnAllowAndSayingNoIsAConversation() {
        val card = card(DeleteCards.runnerTool, runner)
        val allowed = decision(card, CardVerb.DELETE_IT)
        assertEquals("allow", allowed.text("behavior"))
        assertNull(allowed["rememberRules"])
        val refusal = decision(card, CardVerb.CHAT, CardInput("Keep it, the test is not done"))
        assertEquals("deny", refusal.text("behavior"))
        assertEquals("Keep it, the test is not done", refusal.text("message"))
    }

    @Test fun aRunnerCardReadsWhatTheServerFiled() {
        val read = DeleteCards.read(DeleteCards.runnerTool, runner)
        assertEquals(DeleteCard(true, "instance-20261027-071926", false, "2026-10-28T05:46:18.109Z",
            workspaces = listOf(DeleteWorkspace("c2b-loadtest", null), DeleteWorkspace("site", "~/site"))), read)
        val named = JsonObject(runner + mapOf("displayName" to JsonPrimitive("Build box"), "online" to JsonPrimitive(true), "workspaces" to JsonArray(emptyList())))
        val box = DeleteCards.read(DeleteCards.runnerTool, named)
        assertEquals("Build box", box.name)
        assertTrue(box.online)
        assertEquals(emptyList<DeleteWorkspace>(), box.workspaces)
    }

    @Test fun aWorkspaceCardReadsItsRunnerAndFolder() {
        val read = DeleteCards.read(DeleteCards.workspaceTool, workspace)
        assertEquals(DeleteCard(false, "c2b-loadtest", host = "HPC", workDir = "/srv/loadtest"), read)
        assertEquals("On HPC", DeleteCards.onRunner(read.host))
        val alone = DeleteCards.read(DeleteCards.workspaceTool, buildJsonObject { put("agentId", "w1"); put("name", "scratch"); put("runner", JsonNull) })
        assertNull(alone.host)
        assertNull(alone.workDir)
        assertEquals("On no runner", DeleteCards.onRunner(alone.host))
    }

    /** The words are the web's and iOS's, read out of the sources that say them there. A missing source fails, never skips. */
    @Test fun everyClientSaysTheCardTheSameWay() {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }.first { File(it, "src/web/src/components/ApprovalPanel.tsx").isFile }
        val web = File(root, "src/web/src/components/ApprovalPanel.tsx").readText()
        val swift = File(root, "src/macos/OrbitKit/Sources/OrbitKit/App/OrbitAskPreview.swift").readText().replace(Regex("\"\\s*\\+\\s*\""), "")
        listOf(CardVerb.DELETE_IT.label, DeleteCards.goesWith, DeleteCards.noWorkspaces, DeleteCards.runnerNote, DeleteCards.workspaceNote, DeleteCards.onRunner(null)).forEach { words ->
            assertTrue("the web says \"$words\"", web.contains(words))
            assertTrue("iOS says \"$words\"", swift.contains(words))
        }
        assertTrue(swift.contains("\"Delete this \\(noun)?\""))
        val server = File(root, "src/apiserver/src/runner-api/runner-delete-approval.ts").readText()
        listOf(DeleteCards.runnerTool, DeleteCards.workspaceTool).forEach { assertTrue("the server files its card as $it", server.contains("'$it'")) }
    }
}
