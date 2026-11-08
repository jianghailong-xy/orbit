package io.orbitd.android.directory

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/** Who outside Orbit sent a turn: a member of a connected Feishu group whose words the bot handed to one of the owner's sessions
 * (docs/feishu-bot-design.md §8.2; `@orbit/shared` and OrbitKit `ExternalMessageFrom`). [name] is the sender's name as Feishu gave it
 * when the turn was written, null when Feishu would not say. */
data class ExternalMessageFrom(val name: String?)

/** What the sender line says, in the web's own words (src/web/src/lib/externalSender.ts, OrbitKit `ExternalSender`): over the words in
 * the conversation, and in front of them on the session row, where "You:" would put a group member's request in the owner's mouth.
 * ExternalSenderCopyParityTest holds every word here to both sources. */
internal object ExternalSender {
    const val feishuSource = "FEISHU"
    /** Web `EXTERNAL_SENDER_FROM_FEISHU`. */
    const val fromFeishu = "From Feishu"
    /** Web `EXTERNAL_SENDER_NAME_SEPARATOR`. */
    const val nameSeparator = " · "

    /** The sender a payload (`externalSender`) or a row (`lastUserFromExternal`) carries, or null. Anything that is not one — absent,
     * from an older server, or of a source this build does not know — reads as null, so the turn keeps the reading it has always had
     * (web `parseExternalSender`). A blank name is none. */
    fun parse(value: JsonElement?): ExternalMessageFrom? {
        val from = value as? JsonObject ?: return null
        if ((from["source"] as? JsonPrimitive)?.takeIf { it.isString }?.content != feishuSource) return null
        val name = (from["name"] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull?.trim()?.takeIf { it.isNotEmpty() }
        return ExternalMessageFrom(name)
    }

    /** `From Feishu · <name>`, or `From Feishu` when Feishu would not say the name (web `externalSenderLabel`). */
    fun label(from: ExternalMessageFrom): String = from.name?.let { "$fromFeishu$nameSeparator$it" } ?: fromFeishu
}
