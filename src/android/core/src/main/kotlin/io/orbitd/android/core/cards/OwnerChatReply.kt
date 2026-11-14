package io.orbitd.android.core.cards

import io.orbitd.android.core.protocol.Wire
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/**
 * The owner's words from a "Chat about this" on one of Orbit's own asks (a project, a task, a batch, a deletion…), read back from
 * the tool result the runner wrote for the agent (`ownerChatReply` in src/runner-go/mcp.go). They are a message the owner sent, so
 * the transcript draws them as one under the call's row and never folds that call into a steps line.
 *
 * Hand copy of @orbit/shared `ownerChatReply.ts`; `src/shared/src/owner-chat-reply.fixture.json` is the contract both are held to.
 */
object OwnerChatReply {
    private const val LEAD = "Not done yet, and not a no: the owner pressed \"Chat about this\" on the card to talk it over before " +
        "deciding. Their message:\n\n"
    private const val TAIL = "\n\nReply to it as you would to any message from them."
    private val CHAT_OUTCOME = Regex("\"outcome\"\\s*:\\s*\"chat\"")

    /** The owner's words when [result] is a chat reply to a card, otherwise null. */
    fun words(result: String?): String? {
        val reply = result?.let { receiptText(it) ?: it }
        if (reply == null || !reply.startsWith(LEAD)) return null
        val end = reply.lastIndexOf(TAIL)
        if (end < LEAD.length) return null
        return reply.substring(LEAD.length, end).trim().ifEmpty { null }
    }

    /** The words of a call's result when it is one of Orbit's own calls ([toolName]) answered this way. */
    fun words(toolName: String?, result: String?, isError: Boolean): String? =
        if (toolName?.startsWith("mcp__orbit__") == true && !isError) words(result) else null

    /**
     * The reply inside a chat's receipt (outcome "chat"), which is what an engine records in place of the result's text: Claude Code
     * and Codex pass a result's structuredContent on when it has one, and the receipt carries the reply as its `text`
     * (src/runner-go/tool_receipt.go).
     */
    private fun receiptText(result: String): String? {
        if (!result.startsWith("{") || !CHAT_OUTCOME.containsMatchIn(result)) return null
        val receipt = runCatching { Wire.json.parseToJsonElement(result) as? JsonObject }.getOrNull() ?: return null
        if ((receipt["outcome"] as? JsonPrimitive)?.takeIf { it.isString }?.content != "chat") return null
        return (receipt["text"] as? JsonPrimitive)?.takeIf { it.isString }?.content
    }
}
