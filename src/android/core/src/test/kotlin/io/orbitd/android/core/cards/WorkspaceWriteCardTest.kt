package io.orbitd.android.core.cards

import io.orbitd.android.core.protocol.Wire
import java.io.File
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/**
 * A session's write of what decides a workspace's next session, asked on the owner's card (OrbitKit `WorkspaceWritePreview`, web
 * `WorkspaceWriteBody`): the card reads what the server filed, each variable by name and whole value, its yes says what it does,
 * there is no standing yes, and saying no is "Chat about this".
 */
class WorkspaceWriteCardTest {
    private val long = "sk-" + "x".repeat(4000)
    private val update = buildJsonObject {
        put("agentId", "w1"); put("name", "nightly-build"); put("workDir", "/srv/build")
        putJsonObject("runner") { put("id", "r1"); put("name", "instance-1"); put("displayName", "Build box") }
        putJsonArray("envRemoved") { add("OLD_TOKEN") }
        put("writeSalt", "salt"); put("writeDigest", "digest")
        putJsonObject("changes") { putJsonObject("env") { put("REGION", "eu"); put("API_KEY", long) } }
    }
    private val create = buildJsonObject {
        put("agentId", JsonNull); put("name", "one-off"); put("workDir", JsonNull)
        putJsonObject("runner") { put("id", "r1"); put("name", "hpc"); put("displayName", JsonNull) }
        putJsonArray("envRemoved") { }
        putJsonObject("changes") {
            put("name", "one-off")
            putJsonObject("env") { put("FCM_KEY", "k") }
            put("enableWorktree", true)
        }
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

    @Test fun bothWritesAreOneFamilyWithTheirOwnHeadingAndYes() {
        assertEquals(CardFamily.WORKSPACE_WRITE, approvalFamily("orbit_agent_create"))
        assertEquals(CardFamily.WORKSPACE_WRITE, approvalFamily("orbit_agent_update"))
        val change = card(WorkspaceWriteCards.updateTool, update)
        assertEquals("Change this workspace?", change.title)
        assertEquals(listOf(CardVerb.SAVE_CHANGES, CardVerb.CHAT), change.actions)
        assertEquals("Save changes", CardVerb.SAVE_CHANGES.label)
        val made = card(WorkspaceWriteCards.createTool, create)
        assertEquals("Create this workspace?", made.title)
        assertEquals(listOf(CardVerb.CREATE_WORKSPACE, CardVerb.CHAT), made.actions)
        assertEquals("Create it", CardVerb.CREATE_WORKSPACE.label)
    }

    @Test fun aWriteStaysWholeInTheConversationWithNoStandingYes() {
        listOf(WorkspaceWriteCards.updateTool to update, WorkspaceWriteCards.createTool to create).forEach { (tool, input) ->
            assertNull(CardPreviews.preview(card(tool, input)))
            assertEquals(emptyList<PermissionRule>(), ApprovalRules.remember(tool, input))
        }
    }

    @Test fun theYesIsAnAllowAndSayingNoIsAConversation() {
        val card = card(WorkspaceWriteCards.updateTool, update)
        val allowed = decision(card, CardVerb.SAVE_CHANGES)
        assertEquals("allow", allowed.text("behavior"))
        assertNull(allowed["rememberRules"])
        val refusal = decision(card, CardVerb.CHAT, CardInput("Not that key"))
        assertEquals("deny", refusal.text("behavior"))
        assertEquals("Not that key", refusal.text("message"))
    }

    @Test fun aChangeReadsWhatTheServerFiledWithEveryValueWhole() {
        val read = WorkspaceWriteCards.read(WorkspaceWriteCards.updateTool, update)
        assertFalse(read.isCreate)
        assertEquals("nightly-build", read.name)
        assertEquals("Build box", read.host)
        assertEquals("/srv/build", read.workDir)
        assertEquals(listOf("API_KEY=$long", "REGION=eu"), read.env?.map { it.line })
        assertEquals(listOf("OLD_TOKEN"), read.envRemoved)
        assertEquals(emptyList<WorkspaceWriteField>(), read.fields)
    }

    @Test fun aChangeSaysWhatElseItChanges() {
        val read = WorkspaceWriteCards.read(WorkspaceWriteCards.updateTool, buildJsonObject {
            put("name", "w")
            putJsonObject("changes") {
                put("workDir", "/srv/other"); put("systemPrompt", "Answer in French."); put("appendSystemPrompt", "And briefly.")
                putJsonObject("runner") { put("id", "r2"); put("name", "gpu-2"); put("displayName", JsonNull) }
                put("enableWorktree", false); put("name", "renamed"); put("description", "builds at night"); put("defaultMergeTarget", "develop")
            }
        })
        assertNull("a write that leaves the variables alone says nothing of them", read.env)
        assertEquals(listOf(
            WorkspaceWriteField("Working directory", "/srv/other"), WorkspaceWriteField("Base instructions", "Answer in French."),
            WorkspaceWriteField("Runtime instructions", "And briefly."), WorkspaceWriteField("Runner", "gpu-2"),
            WorkspaceWriteField("Worktree", "Sessions run in the shared folder"), WorkspaceWriteField("Name", "renamed"),
            WorkspaceWriteField("Description", "builds at night"), WorkspaceWriteField("Merge target", "develop")), read.fields)
    }

    @Test fun aClearedFieldSaysSoAndACreateKeepsItsNameInItsOwnRow() {
        val cleared = WorkspaceWriteCards.read(WorkspaceWriteCards.updateTool, buildJsonObject {
            put("name", "w"); putJsonArray("envRemoved") { add("A"); add("B") }
            putJsonObject("changes") { putJsonObject("env") { }; put("systemPrompt", "") }
        })
        assertEquals(emptyList<WorkspaceWriteVariable>(), cleared.env)
        assertEquals(listOf("A", "B"), cleared.envRemoved)
        assertEquals(listOf(WorkspaceWriteField("Base instructions", "Cleared")), cleared.fields)
        val made = WorkspaceWriteCards.read(WorkspaceWriteCards.createTool, create)
        assertTrue(made.isCreate)
        assertEquals("hpc", made.host)
        assertNull(made.workDir)
        assertEquals(listOf("FCM_KEY=k"), made.env?.map { it.line })
        assertEquals(listOf(WorkspaceWriteField("Worktree", "Each session gets its own git worktree")), made.fields)
    }

    /** The words are the web's and iOS's, read out of the sources that say them there. A missing source fails, never skips. */
    @Test fun everyClientSaysTheCardTheSameWay() {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }.first { File(it, "src/web/src/components/ApprovalPanel.tsx").exists() }
        val join = Regex("['\"`]\\s*\\+\\s*\\n?\\s*['\"`]")
        val web = File(root, "src/web/src/components/ApprovalPanel.tsx").readText().replace(join, "")
        val swift = File(root, "src/macos/OrbitKit/Sources/OrbitKit/App/OrbitAskPreview.swift").readText().replace(join, "")
        listOf(CardVerb.SAVE_CHANGES.label, CardVerb.CREATE_WORKSPACE.label, WorkspaceWriteCards.variables, WorkspaceWriteCards.noVariables,
            WorkspaceWriteCards.removed, WorkspaceWriteCards.note, "Working directory", "Base instructions", "Runtime instructions", "Runner", "Worktree",
            "Each session gets its own git worktree", "Sessions run in the shared folder", "Name", "Description", "Merge target", "Cleared").forEach { words ->
            assertTrue("the web says \"$words\"", web.contains(words))
            assertTrue("iOS says \"$words\"", swift.contains(words))
        }
        listOf(WorkspaceWriteCards.title(WorkspaceWriteCards.createTool), WorkspaceWriteCards.title(WorkspaceWriteCards.updateTool)).forEach {
            assertTrue("iOS says \"$it\"", swift.contains(it))
        }
        val server = File(root, "src/apiserver/src/sessions/workspace-write-card-values.ts").readText()
        listOf(WorkspaceWriteCards.createTool, WorkspaceWriteCards.updateTool).forEach { assertTrue("the server files its card as $it", server.contains("'$it'")) }
    }
}
