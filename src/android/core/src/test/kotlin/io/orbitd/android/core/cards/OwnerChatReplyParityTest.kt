package io.orbitd.android.core.cards

import io.orbitd.android.core.protocol.Wire
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Test
import java.io.File

/**
 * The owner's "Chat about this" reply to a card is read back the way the browser and OrbitKit read it.
 * `src/shared/src/owner-chat-reply.fixture.json` is the contract: the runner writes it, and every client's reader is proved against
 * it. A missing fixture is a failure, never a skip.
 */
class OwnerChatReplyParityTest {
    private val fixture: JsonObject by lazy {
        val file = generateSequence(File(System.getProperty("user.dir")).absoluteFile) { it.parentFile }
            .map { File(it, "src/shared/src/owner-chat-reply.fixture.json") }.firstOrNull { it.isFile }
        assertNotNull("src/shared/src/owner-chat-reply.fixture.json was not found above ${System.getProperty("user.dir")}", file)
        Wire.json.parseToJsonElement(file!!.readText()).jsonObject
    }

    @Test fun everyCaseReadsAsTheFixtureSays() {
        for (c in fixture["cases"]!!.jsonArray.map { it.jsonObject }) {
            val words = (c["words"] as? JsonPrimitive)?.takeIf { it.isString }?.content
            assertEquals(c["name"]!!.jsonPrimitive.content, words, OwnerChatReply.words(c["result"]!!.jsonPrimitive.content))
        }
    }

    @Test fun onlyOrbitsOwnCallsAreRead() {
        val reply = fixture["cases"]!!.jsonArray[0].jsonObject["result"]!!.jsonPrimitive.content
        assertNotNull(OwnerChatReply.words("mcp__orbit__project_create", reply, isError = false))
        assertNull(OwnerChatReply.words("Bash", reply, isError = false))
        assertNull(OwnerChatReply.words("mcp__orbit__project_create", reply, isError = true))
    }
}
