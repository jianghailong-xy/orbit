package io.orbitd.android.core.cards

import io.orbitd.android.core.protocol.Wire
import java.io.File
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test

/**
 * A provider write asked on the owner's card (OrbitKit `ProviderWritePreview`, web `ProviderWriteBody`): the card reads the fields the
 * write sets by name and the models one a row, its yes says what it does, there is no standing yes, and the key is never a value.
 */
class ProviderWriteCardTest {
    private val update = buildJsonObject {
        put("slug", "ollama-hpc-responses")
        putJsonArray("models") {
            addJsonObject { put("label", "Qwen3.8 27B (Ollama, 64K)"); put("value", "qwen3.8:27b"); put("contextWindow", 65536) }
            addJsonObject { put("label", "Qwen3 Coder 30B (Ollama, 64K)"); put("value", "qwen3-coder:30b"); put("contextWindow", 65536) }
        }
        put("defaultModel", "qwen3.8:27b")
    }
    private val create = buildJsonObject {
        put("label", "Local vLLM"); put("runtime", "codex"); put("baseUrl", "http://127.0.0.1:8000/v1"); put("apiKey", "(set — not shown)")
    }
    private fun card(tool: String, input: JsonObject): InteractionCard {
        val source = fixture().obj("snapshot")!!
        val approval = buildJsonObject {
            put("id", "p1"); put("sessionId", fixture().text("sessionId")); put("toolName", tool); put("input", input); put("status", "PENDING")
        }
        return cardList(JsonObject(source + ("approvals" to JsonArray(listOf(approval))))).single { it.key == "approval:p1" }
    }

    @Test fun eachWriteHasItsOwnHeadingAndYesAndNoStandingYes() {
        val change = card(ProviderWriteCards.updateTool, update)
        assertEquals(CardFamily.PROVIDER, change.family)
        assertEquals("Change this provider?", change.title)
        assertEquals(listOf(CardVerb.SAVE_CHANGES, CardVerb.DENY), change.actions)
        val add = card(ProviderWriteCards.createTool, create)
        assertEquals("Add this provider?", add.title)
        assertEquals(listOf(CardVerb.ADD_PROVIDER, CardVerb.DENY), add.actions)
        assertEquals("Add it", CardVerb.ADD_PROVIDER.label)
        val delete = card(ProviderWriteCards.deleteTool, buildJsonObject { put("slug", "old") })
        assertEquals("Delete this provider?", delete.title)
        assertEquals(listOf(CardVerb.DELETE_IT, CardVerb.DENY), delete.actions)
    }

    @Test fun theYesAllowsAndTheNoDenies() {
        val change = card(ProviderWriteCards.updateTool, update)
        fun behavior(verb: CardVerb) = Wire.json.parseToJsonElement(CardRequests.build(change, verb).body!!.decodeToString()).jsonObject.text("behavior")
        assertEquals("allow", behavior(CardVerb.SAVE_CHANGES))
        assertEquals("deny", behavior(CardVerb.DENY))
    }

    @Test fun anUpdateReadsAsItsFieldsAndModels() {
        val read = ProviderWriteCards.read(ProviderWriteCards.updateTool, update)
        assertEquals("ollama-hpc-responses", read.name)
        assertEquals("nothing the write leaves alone", listOf(ProviderWriteField("Default model", "qwen3.8:27b", true)), read.fields)
        assertEquals(listOf(true, false), read.models?.map { it.isDefault })
        assertEquals("Qwen3 Coder 30B (Ollama, 64K) · 64K context", read.models?.get(1)?.detail)
    }

    @Test fun anAddNamesItsProtocolAndNeverShowsAKey() {
        val read = ProviderWriteCards.read(ProviderWriteCards.createTool, buildJsonObject {
            create.forEach { (k, v) -> put(k, v) }; put("token", "secret-value"); put("region", "eu")
        })
        assertEquals("Local vLLM", read.name)
        assertEquals(listOf("OpenAI Responses (codex)", "http://127.0.0.1:8000/v1", "Set — not shown", "eu", "Set — not shown"), read.fields.map { it.value })
        assertFalse(read.fields.any { "secret-value" in it.value })
        assertNull(read.models)
        assertEquals("64K", ProviderWriteCards.contextSize(65536))
        assertEquals("200K", ProviderWriteCards.contextSize(200_000))
        assertEquals("1M", ProviderWriteCards.contextSize(1_048_576))
        assertEquals("1M", ProviderWriteCards.contextSize(1_000_000))
    }

    /** The words are the web's and iOS's, read out of the sources that say them there. A missing source fails, never skips. */
    @Test fun everyClientSaysTheCardTheSameWay() {
        val root = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }.first { File(it, "src/web/src/components/ApprovalPanel.tsx").exists() }
        val web = File(root, "src/web/src/components/ApprovalPanel.tsx").readText()
        val swift = File(root, "src/macos/OrbitKit/Sources/OrbitKit/App/OrbitAskPreview.swift").readText()
        listOf(CardVerb.ADD_PROVIDER.label, CardVerb.SAVE_CHANGES.label, CardVerb.DELETE_IT.label, ProviderWriteCards.modelsReplace,
            ProviderWriteCards.changeNote, ProviderWriteCards.deleteNote, ProviderWriteCards.keySet, "Protocol", "Base URL", "API key",
            "Default model", "OpenAI Responses", "Anthropic Messages").forEach { words ->
            assertTrue("the web says \"$words\"", web.contains(words))
            assertTrue("iOS says \"$words\"", swift.contains(words))
        }
        listOf(ProviderWriteCards.createTool, ProviderWriteCards.updateTool, ProviderWriteCards.deleteTool).forEach {
            assertTrue("iOS says \"${ProviderWriteCards.title(it)}\"", swift.contains(ProviderWriteCards.title(it)))
        }
    }
}
