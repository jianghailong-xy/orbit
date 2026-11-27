package io.orbitd.android.core.cards

import kotlinx.serialization.json.*

/**
 * The owner cards that live outside a session, in the owner's language (board docs/mocks/session-translation/04-owner-cards.html;
 * `OwnerCardTranslation` and `EvidenceTranslation` in src/shared/src/translation.ts): a coordinator's question, start and done
 * request, an owner request, an owner confirmation's report and review, completion evidence, a criteria-change proposal and a
 * crossing. Each carries an optional `translation` beside the fields the agent wrote, which stay exactly as written.
 *
 * A card is drawn translated whole, or as the agent wrote it: a translation that is absent, `failed`, in a language other than the
 * owner's current one ([owner]: the owner's language while their translation is on, null while it is off), or changes nothing the card
 * draws yields null here, and the card is drawn as it came, with no "Translated · Show original" foot. The fields each card
 * translates are the server's (`*_FIELDS` in src/apiserver/src/sessions/card-translation.ts); a field the original lacks is never
 * added, and arrays go index for index. Answers go by index, so a translated option label changes no press.
 *
 * A project's own title and criteria carry theirs on the project document instead ([project]; `ProjectTextTranslation`), under the same
 * rule.
 */
object OwnerCardTranslation {
    /** Which of a card's fields are the agent's words, as the server names them (`CardFields`). */
    sealed interface Field {
        /** A string field. */
        data object Words : Field
        /** An array of strings. */
        data object WordsList : Field
        /** An array of objects with these fields. */
        data class Items(val fields: Map<String, Field>) : Field
    }

    private val OPTIONS = Field.Items(mapOf("label" to Field.Words, "description" to Field.Words))
    val QUESTION_FIELDS = mapOf("question" to Field.Words, "options" to OPTIONS, "ifUnanswered" to Field.Words)
    val OWNER_REQUEST_FIELDS = mapOf("title" to Field.Words, "why" to Field.Words, "ifUnanswered" to Field.Words, "options" to OPTIONS,
        "steps" to Field.Items(mapOf("text" to Field.Words)), "verifyHint" to Field.Words)
    val START_REQUEST_FIELDS = mapOf("why" to Field.Words)
    val DONE_REQUEST_FIELDS = mapOf("judgment" to Field.Words,
        "gaps" to Field.Items(mapOf("title" to Field.Words, "whyNotProven" to Field.Words, "coordinatorChecked" to Field.Words)))
    val EVIDENCE_FIELDS = mapOf("claim" to Field.Words, "gaps" to Field.WordsList)
    val REVIEW_FIELDS = mapOf("judgment" to Field.Words, "needsYou" to Field.Items(mapOf("text" to Field.Words, "options" to OPTIONS)))
    val PROBLEMS_FIELDS = mapOf("reason" to Field.Words, "problems" to Field.Items(mapOf("text" to Field.Words)))
    val CROSSING_FIELDS = mapOf("title" to Field.Words, "reason" to Field.Words)
    val CRITERIA_FIELDS = mapOf("proposed" to Field.Items(mapOf("text" to Field.Words, "verificationMethod" to Field.Words)))

    /** A translation the card can be drawn in: an object in the [owner]'s language that is not `failed`. [owner] is null while the
     *  owner's translation is off, and then none is. */
    fun usable(translation: JsonElement?, owner: String?): JsonObject? =
        (translation as? JsonObject)?.takeIf { owner != null && it.text("lang") == owner && (it["failed"] as? JsonPrimitive)?.booleanOrNull != true }

    /** [original] with [translation]'s words in place of each of [fields] it has; everything else as it is. */
    fun overlay(original: JsonObject, translation: JsonObject, fields: Map<String, Field>): JsonObject {
        val next = original.toMutableMap()
        fields.forEach { (key, field) ->
            val was = original[key] ?: return@forEach
            val now = translation[key] ?: return@forEach
            when (field) {
                Field.Words -> (now as? JsonPrimitive)?.takeIf { it.isString && it.content.isNotEmpty() && was is JsonPrimitive && was.isString }
                    ?.let { next[key] = it }
                Field.WordsList -> if (was is JsonArray && now is JsonArray) next[key] = JsonArray(was.mapIndexed { i, item ->
                    (now.getOrNull(i) as? JsonPrimitive)?.takeIf { it.isString && it.content.isNotEmpty() && item is JsonPrimitive && item.isString } ?: item
                })
                is Field.Items -> if (was is JsonArray && now is JsonArray) next[key] = JsonArray(was.mapIndexed { i, item ->
                    val t = now.getOrNull(i) as? JsonObject
                    if (item is JsonObject && t != null) overlay(item, t, field.fields) else item
                })
            }
        }
        return JsonObject(next)
    }

    /** [original] drawn in [translation], or null when there is none to draw it in, or it changes nothing. */
    fun translated(original: JsonObject, translation: JsonElement?, fields: Map<String, Field>, owner: String?): JsonObject? {
        val t = usable(translation, owner) ?: return null
        return overlay(original, t, fields).takeIf { it != original }
    }

    /** [row] with its nested [key] object drawn in the row's own `translation`; null when that changes nothing. */
    private fun nested(row: JsonObject, key: String, fields: Map<String, Field>, owner: String?): JsonObject? {
        val inner = row.obj(key) ?: return null
        return translated(inner, row["translation"], fields, owner)?.let { JsonObject(row + (key to it)) }
    }

    /** A project open item (ProjectOpenItemRow): a COORDINATOR_QUESTION's `question` and its `detailLine` (the server's line built
     * from the translated `ifUnanswered`, `translation.detailLine`), a START_REQUEST's `startRequest.why`, a DONE_REQUEST's
     * `doneRequest`, each from the row's `translation`. */
    fun openItem(row: JsonObject, owner: String?): JsonObject? = when (row.text("kind")) {
        "COORDINATOR_QUESTION" -> {
            val shown = nested(row, "question", QUESTION_FIELDS, owner) ?: row
            val line = usable(row["translation"], owner)?.let { words(it, "detailLine") }
            (if (line != null && row["detailLine"] is JsonPrimitive) JsonObject(shown + ("detailLine" to JsonPrimitive(line))) else shown)
                .takeIf { it != row }
        }
        "START_REQUEST" -> nested(row, "startRequest", START_REQUEST_FIELDS, owner)
        "DONE_REQUEST" -> nested(row, "doneRequest", DONE_REQUEST_FIELDS, owner)
        else -> null
    }

    /** The project page's open-items list row (iOS `listTitle` / `listDetailLine`, web `OpenItemRowView`): the server's translated
     * `translation.title` (a question's "Coordinator asks: " kept in English) and `translation.detailLine` while a usable translation
     * exists, the row's `title` and `detailLine` otherwise. A list row has no flip of its own: the card it opens offers Show original. */
    fun listTitle(row: JsonObject, owner: String?): String =
        usable(row["translation"], owner)?.let { words(it, "title") } ?: row.text("title").orEmpty()

    fun listDetailLine(row: JsonObject, owner: String?): String =
        usable(row["translation"], owner)?.let { words(it, "detailLine") } ?: row.text("detailLine").orEmpty()

    /** A handed-over item's `handoverNote` as the who-fixes card draws it under [ExceptionCards.handoverNoteCaption] (web
     * `handoverNoteShown`, iOS `shownHandoverNote`): the row's `translation.handoverNote` while a usable translation exists and the card
     * is not flipped, the note as the coordinator wrote it otherwise, and null when the item carries no note. */
    fun handoverNote(row: JsonObject, owner: String?, showOriginal: Boolean): String? {
        val note = row.text("handoverNote")?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        if (showOriginal) return note
        return usable(row["translation"], owner)?.let { words(it, "handoverNote") }?.trim()?.takeIf { it.isNotEmpty() } ?: note
    }

    /** Whether the hand-over note has a translation to flip to: the card draws "Translated · Show original" under it only then. */
    fun handoverNoteTranslates(row: JsonObject, owner: String?): Boolean =
        handoverNote(row, owner, showOriginal = false) != handoverNote(row, owner, showOriginal = true)

    /** A question that has ended (ProjectClosedQuestion): its `question`, as it was translated while open. */
    fun closedQuestion(record: JsonObject, owner: String?): JsonObject? = nested(record, "question", QUESTION_FIELDS, owner)

    /** An owner request, as the card draws it. */
    fun ownerRequest(request: OwnerRequest, owner: String?): OwnerRequest? {
        val t = usable(request.translation, owner) ?: return null
        val shown = request.copy(
            title = words(t, "title") ?: request.title,
            why = words(t, "why")?.takeIf { request.why.isNotEmpty() } ?: request.why,
            ifUnanswered = request.ifUnanswered?.let { words(t, "ifUnanswered") ?: it },
            verifyHint = request.verifyHint?.let { words(t, "verifyHint") ?: it },
            options = request.options?.mapIndexed { i, option ->
                val to = (t["options"] as? JsonArray)?.getOrNull(i) as? JsonObject ?: return@mapIndexed option
                option.copy(label = words(to, "label") ?: option.label, description = option.description?.let { words(to, "description") ?: it })
            },
            // A step's command and link are never translated: the owner copies and opens them as written.
            steps = request.steps?.mapIndexed { i, step ->
                ((t["steps"] as? JsonArray)?.getOrNull(i) as? JsonObject)?.let { words(it, "text") }?.let { step.copy(text = it) } ?: step
            },
        )
        return shown.takeIf { it != request }
    }

    /** A project document (`GET /projects/:id`) with its `title` and each criterion's `text` in the owner's language, from its
     * `translation` (`ProjectTextTranslation`), a criterion matched by its `id`: what the done card and the page's criteria list draw.
     * Only those words change; writes keep reading the document as it came. */
    fun project(doc: JsonObject, owner: String?): JsonObject? {
        val t = usable(doc["translation"], owner) ?: return null
        val byId = t.objects("criteria").associateBy { it.text("id") }
        val shown = overlay(doc, t, mapOf("title" to Field.Words)).toMutableMap()
        (doc["acceptanceCriteriaItems"] as? JsonArray)?.let { items ->
            shown["acceptanceCriteriaItems"] = JsonArray(items.map { item ->
                val words = (item as? JsonObject)?.let { byId[it.text("id")] }
                if (item is JsonObject && words != null) overlay(item, words, mapOf("text" to Field.Words)) else item
            })
        }
        return JsonObject(shown).takeIf { it != doc }
    }

    /** A pending completion-evidence row: its `claim` and `gaps` (EvidenceTranslation). */
    fun evidence(row: JsonObject, owner: String?): JsonObject? = translated(row, row["translation"], EVIDENCE_FIELDS, owner)

    /** A crossing (a `GET /projects/:id/handoffs` row): its `title` and `reason`. */
    fun crossing(row: JsonObject, owner: String?): JsonObject? = translated(row, row["translation"], CROSSING_FIELDS, owner)

    /**
     * A pending criteria-change proposal: each proposed criterion's `text` and `verificationMethod`. The card draws the proposal as
     * its diff against the criteria in force, cut word by word from the agent's own words; drawn translated, each entry shows what is
     * on record and what is proposed, the proposal in the owner's language, matched to `proposed` by ordinal, without that cut.
     */
    fun criteria(row: JsonObject, owner: String?): JsonObject? {
        val proposed = translated(row, row["translation"], CRITERIA_FIELDS, owner) ?: return null
        val byOrdinal = proposed.objects("proposed").associateBy { it.number("ordinal") }
        val diff = row.obj("diff") ?: return proposed
        val entries = diff.objects("entries").map { entry ->
            val wording = entry.obj("proposed") ?: return@map entry
            val t = byOrdinal[entry.number("ordinal")] ?: return@map entry
            val next = wording.toMutableMap()
            t.text("text")?.let { next["text"] = JsonPrimitive(it) }
            if (wording["verificationMethod"] is JsonPrimitive && wording["verificationMethod"] != JsonNull)
                t.text("verificationMethod")?.let { next["verificationMethod"] = JsonPrimitive(it) }
            JsonObject(entry + mapOf("proposed" to JsonObject(next), "rewrites" to JsonArray(emptyList())))
        }
        return JsonObject(proposed + ("diff" to JsonObject(diff + ("entries" to JsonArray(entries)))))
    }

    /**
     * An owner-confirmation read (OwnerConfirmationReviewView) with what is waiting drawn in the owner's language: the run's report
     * (its run event's own translation, `{ lang, text }`), the review's `judgment` and `needsYou`, and a PROBLEMS record's `reason`
     * and `problems`.
     */
    fun confirmation(view: JsonObject, owner: String?): JsonObject? {
        val waiting = view.obj("waiting") ?: return null
        val next = waiting.toMutableMap()
        waiting.obj("report")?.let { report ->
            val text = usable(report["translation"], owner)?.text("text")?.takeIf { it.isNotEmpty() }
            if (text != null && report["text"] is JsonPrimitive) next["report"] = JsonObject(report + ("text" to JsonPrimitive(text)))
        }
        waiting.obj("review")?.let { review ->
            val reviewed = review.toMutableMap()
            review.obj("review")?.let { record -> translated(record, record["translation"], REVIEW_FIELDS, owner)?.let { reviewed["review"] = it } }
            review.obj("problems")?.let { record -> translated(record, record["translation"], PROBLEMS_FIELDS, owner)?.let { reviewed["problems"] = it } }
            next["review"] = JsonObject(reviewed)
        }
        val shown = JsonObject(view + ("waiting" to JsonObject(next)))
        return shown.takeIf { it != view }
    }

    /** A card from [CardCatalog] drawn in the owner's language, or null when it has no translation to draw. Its binding and its
     * doors are the card's own: only what it draws changes. */
    fun card(card: InteractionCard, owner: String?): InteractionCard? = when (card.family) {
        CardFamily.OWNER_QUESTION, CardFamily.START -> openItem(card.source, owner)?.let { card.copy(source = it) }
        CardFamily.QUESTION_RECORD -> closedQuestion(card.source, owner)?.let { card.copy(source = it) }
        CardFamily.EVIDENCE -> if (card.key.startsWith("receipt:")) null else evidence(card.source, owner)?.let { card.copy(source = it) }
        CardFamily.CRITERIA_CHANGE -> if (card.key.startsWith("receipt:")) null else criteria(card.source, owner)?.let { card.copy(source = it) }
        CardFamily.OWNER_CONFIRMATION -> if (card.context.text("ownerCard") != "question") null else confirmation(card.source, owner)?.let { shown ->
            card.copy(source = shown, context = JsonObject(card.context + ("view" to shown)))
        }
        else -> null
    }

    private fun words(t: JsonObject, key: String): String? = t.text(key)?.takeIf { it.isNotEmpty() }
}
