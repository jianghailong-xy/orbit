package io.orbitd.android.directory

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/** Who other than the owner sent a turn (`@orbit/shared` and OrbitKit `ExternalMessageFrom`): a member of a connected Feishu group
 * whose words the bot handed to one of the owner's sessions (`FEISHU`, docs/feishu-bot-design.md §8.2), or an Orbit account the owner
 * invited to reply in this session (`ORBIT_GUEST`, docs/session-guests-design.md §3). [name] is the sender's name when the turn was
 * written: as Feishu gave it (null when Feishu would not say), or the guest's Orbit account name, which a guest always has. */
data class ExternalMessageFrom(val name: String?, val source: String = ExternalSender.feishuSource)

/** What the sender line says, in the web's own words (src/web/src/lib/externalSender.ts, OrbitKit `ExternalSender`): over the words in
 * the conversation, and in front of them on the session row, where "You:" would put a group member's request in the owner's mouth.
 * ExternalSenderCopyParityTest holds every word here to both sources. */
internal object ExternalSender {
    const val feishuSource = "FEISHU"
    /** Web `EXTERNAL_SENDER_FROM_FEISHU`. */
    const val fromFeishu = "From Feishu"
    /** Web `EXTERNAL_SENDER_NAME_SEPARATOR`. */
    const val nameSeparator = " · "
    const val guestSource = "ORBIT_GUEST"
    /** Web `EXTERNAL_SENDER_FROM_GUEST`: a guest is named after it, `From <name>`. */
    const val fromGuest = "From"

    /** The sender a payload (`externalSender`) or a row (`lastUserFromExternal`) carries, or null. Anything that is not one — absent,
     * from an older server, or of a source this build does not know — reads as null, so the turn keeps the reading it has always had
     * (web `parseExternalSender`). A blank name is none. A guest is an Orbit account, which always has a name: one without it is not a
     * guest this build can name, and reads as no sender. */
    fun parse(value: JsonElement?): ExternalMessageFrom? {
        val from = value as? JsonObject ?: return null
        val source = (from["source"] as? JsonPrimitive)?.takeIf { it.isString }?.content
        val name = (from["name"] as? JsonPrimitive)?.takeIf { it.isString }?.contentOrNull?.trim()?.takeIf { it.isNotEmpty() }
        return when (source) {
            feishuSource -> ExternalMessageFrom(name)
            guestSource -> name?.let { ExternalMessageFrom(it, guestSource) }
            else -> null
        }
    }

    /** `From <name>` for a guest; `From Feishu · <name>`, or `From Feishu` when Feishu would not say the name (web
     * `externalSenderLabel`). */
    fun label(from: ExternalMessageFrom): String = when {
        from.source == guestSource && from.name != null -> "$fromGuest ${from.name}"
        else -> from.name?.let { "$fromFeishu$nameSeparator$it" } ?: fromFeishu
    }
}
