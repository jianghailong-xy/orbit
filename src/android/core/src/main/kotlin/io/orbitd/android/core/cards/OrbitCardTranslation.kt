package io.orbitd.android.core.cards

import io.orbitd.android.core.translation.Translation
import kotlinx.serialization.json.JsonObject

/**
 * Orbit's own create, batch, project, blocker and DAG-change cards in the owner's language (board 04-owner-cards.html, part 2): the
 * card's source is drawn translated ([Translation.shownApproval]), and the card as it came rides in its context, so the card's one
 * "Translated · Show original" foot flips the whole card back to the agent's words. A card the server did not translate, or could not
 * (`failed`), or whose translation changes nothing the card draws, carries no original and has no foot.
 */
object OrbitCardTranslation {
    private const val ORIGINAL = "untranslated"

    /** The context an approval card is built with: the card as it came when [shown] differs from it on one of Orbit's cards. */
    fun context(toolName: String, raw: JsonObject, shown: JsonObject): JsonObject =
        if (toolName in Translation.ORBIT_CARDS && shown != raw) JsonObject(mapOf(ORIGINAL to raw)) else emptyObject

    /** Whether the card is drawn translated, and so has the foot. */
    fun translated(card: InteractionCard): Boolean = card.context.obj(ORIGINAL) != null

    /** The card as drawn: translated, or with [showOriginal] the card as the agent wrote it. */
    fun shown(card: InteractionCard, showOriginal: Boolean): InteractionCard =
        if (showOriginal) card.context.obj(ORIGINAL)?.let { card.copy(source = it) } ?: card else card
}
