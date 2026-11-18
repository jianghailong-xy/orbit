package io.orbitd.android.core.translation

import io.orbitd.android.core.realtime.RunEvent
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull

/**
 * Settings › Translation (board docs/mocks/session-translation/01-board.png), read from the wire shapes the server owns
 * (src/shared/src/translation.ts). The server translates; a client only reads what it wrote and calls its doors.
 */
object Translation {
    /** The one curated list both pickers offer, "Your language" and "Agents work in", in the order of TRANSLATION_LANGUAGES, each with
     * its English name (TRANSLATION_LANGUAGE_NAMES). */
    val LANGUAGES: List<Pair<String, String>> = listOf(
        "en" to "English",
        "zh-Hans" to "Chinese (Simplified)",
        "zh-Hant" to "Chinese (Traditional)",
        "ja" to "Japanese",
        "ko" to "Korean",
        "es" to "Spanish",
        "fr" to "French",
        "de" to "German",
        "ru" to "Russian",
        "pt" to "Portuguese",
        "it" to "Italian",
        "nl" to "Dutch",
        "ar" to "Arabic",
        "hi" to "Hindi",
        "tr" to "Turkish",
        "vi" to "Vietnamese",
        "th" to "Thai",
        "id" to "Indonesian",
        "pl" to "Polish",
        "uk" to "Ukrainian",
        "he" to "Hebrew",
        "sv" to "Swedish",
        "cs" to "Czech",
        "da" to "Danish",
        "fi" to "Finnish",
        "el" to "Greek",
        "hu" to "Hungarian",
        "ro" to "Romanian",
        "ms" to "Malay",
        "bn" to "Bengali",
    )
    /** What a preference without an owner language means (DEFAULT_TRANSLATION_LANGUAGE). */
    const val DEFAULT_LANGUAGE = "zh-Hans"
    /** What a preference without an agent language means: English, as before it could be chosen (DEFAULT_AGENT_LANGUAGE). */
    const val DEFAULT_AGENT_LANGUAGE = "en"
    /** The 422 code of a question answer whose words could not be translated: nothing was recorded (TRANSLATION_FAILED_CODE). */
    const val FAILED_CODE = "TRANSLATION_FAILED"

    /** Whether a door refused the owner's words because they could not be translated: nothing was recorded, and the card offers
     * Retry and Send as written. */
    fun refused(error: Throwable?): Boolean = (error as? io.orbitd.android.core.net.ApiError)?.code == FAILED_CODE

    fun isLanguage(value: String?): Boolean = LANGUAGES.any { it.first == value }
    fun name(lang: String): String = LANGUAGES.firstOrNull { it.first == lang }?.second ?: lang
    /** The name without its parenthesis: "Chinese (Simplified)" reads "Chinese". */
    fun shortName(lang: String): String = name(lang).replace(Regex("\\s*\\(.*\\)$"), "")

    /** The composer tag (6A): "<Language> → <Agent language>", both without their parenthesis — "Chinese → English". */
    fun tag(lang: String, agentLang: String = DEFAULT_AGENT_LANGUAGE): String = "${shortName(lang)} → ${shortName(agentLang)}"

    /** The account's language: `preferences.translationLanguage`, absent (or unknown) = the default pick. */
    fun language(preferences: JsonObject?): String =
        preferences?.string("translationLanguage")?.takeIf(::isLanguage) ?: DEFAULT_LANGUAGE

    /** The language agents work in: `preferences.translationAgentLanguage`, absent (or unknown) = English. */
    fun agentLanguage(preferences: JsonObject?): String =
        preferences?.string("translationAgentLanguage")?.takeIf(::isLanguage) ?: DEFAULT_AGENT_LANGUAGE

    /** `preferences.translationEnabled`: on only for an explicit true. */
    fun enabled(preferences: JsonObject?): Boolean = (preferences?.get("translationEnabled") as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull == true

    /** "Show both languages" (`preferences.translationBilingual`, docs/mocks/session-translation/02-bilingual.png): on only for an
     *  explicit true, and drawn only while [enabled] (web `bilingualOn`). */
    fun bilingual(preferences: JsonObject?): Boolean =
        enabled(preferences) && (preferences?.get("translationBilingual") as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull == true

    /** Over this many lines the English of a reply drawn whole (its blocks do not pair, [bilingualPairs]) starts collapsed to a
     *  two-line preview (frame 3, B): BILINGUAL_COLLAPSE_LINES. An interleaved reply never collapses. */
    const val BILINGUAL_COLLAPSE_LINES = 6
    /** A source line wraps every this many characters, for the count: BILINGUAL_LINE_CHARS. */
    const val BILINGUAL_LINE_CHARS = 60

    /** The English drawn under a translated message: its prose only — a fenced code block is drawn once, above (board mark D). An
     *  unclosed fence is left as it is. The same rule as @orbit/shared `bilingualEnglish`. */
    fun bilingualEnglish(text: String): String {
        val lines = text.split("\n")
        val out = mutableListOf<String>()
        var i = 0
        while (i < lines.size) {
            val fence = fenceOpener(lines[i])
            val close = if (fence == null) -1 else (i + 1 until lines.size).firstOrNull { isFence(lines[it], fence) } ?: -1
            if (close >= 0) { out.add(""); i = close + 1; continue }
            out.add(lines[i]); i += 1
        }
        return out.joinToString("\n").replace(Regex("\n{3,}"), "\n\n").trim()
    }

    /** How many lines [english] runs to: each non-blank source line, wrapped every [BILINGUAL_LINE_CHARS] (`bilingualLineCount`). */
    fun bilingualLineCount(english: String): Int = english.split("\n").sumOf { line ->
        val t = line.trim()
        val length = t.codePointCount(0, t.length)
        (length + BILINGUAL_LINE_CHARS - 1) / BILINGUAL_LINE_CHARS
    }

    private fun leadingSpaces(line: String): String? {
        val n = line.takeWhile { it == ' ' }.length
        return if (n <= 3) line.substring(n) else null
    }
    private fun fenceOpener(line: String): String? = leadingSpaces(line)?.let { rest ->
        when { rest.startsWith("```") -> "```"; rest.startsWith("~~~") -> "~~~"; else -> null }
    }
    private fun isFence(line: String, fence: String): Boolean = leadingSpaces(line)?.startsWith(fence) == true

    /** One block kind of [bilingualPairs]. */
    enum class BlockKind { PARAGRAPH, HEADING, ITEM, QUOTE, OTHER }

    /**
     * One block of the translation, in order: [text] without its indentation (an item's without its [marker], a quote's without its
     * `>`s, a heading's whole line), and [original] the matching block of the original in the same form — a heading's words alone.
     * [BlockKind.OTHER] carries no original.
     */
    data class BilingualPair(val kind: BlockKind, val depth: Int, val marker: String?, val text: String, val original: String?) {
        /** An ordered item's number ("3." → 3); null for a bullet. */
        val number: Int? get() = marker?.takeIf { it.first() in '0'..'9' }?.dropLast(1)?.toIntOrNull()
    }

    private class Block(val kind: BlockKind, val depth: Int, val marker: String?, val body: String, val words: String)

    private val PAIR_HEADING = Regex("^ {0,3}(#{1,6})(?: +|$)(.*)$")
    private val PAIR_ITEM = Regex("^( *)([-*+]|[0-9]{1,9}[.)])( +|$)(.*)$")
    private val PAIR_BREAK = Regex("^ {0,3}([-*_])(?: *\\1){2,} *$")
    private val PAIR_FENCE = Regex("^ *(```|~~~)")
    private val PAIR_QUOTE = Regex("^ {0,3}>")
    private val PAIR_TABLE = Regex("^ *\\|")
    private val PAIR_IMAGES = Regex("^(?:!\\[[^\\]]*\\]\\([^)]*\\)\\s*)+$")
    private val PAIR_HEADING_CLOSE = Regex("(?:^| +)#+ *$")
    private val PAIR_QUOTE_MARK = Regex("^ {0,3}> ?")

    private fun indentOf(line: String): Int = line.takeWhile { it == ' ' }.length
    private fun dedent(line: String, n: Int): String = line.substring(minOf(n, indentOf(line)))
    private fun startsBlock(line: String): Boolean =
        PAIR_FENCE.containsMatchIn(line) || PAIR_HEADING.containsMatchIn(line) || PAIR_BREAK.containsMatchIn(line) ||
            PAIR_ITEM.containsMatchIn(line) || PAIR_QUOTE.containsMatchIn(line) || PAIR_TABLE.containsMatchIn(line)

    private fun bilingualBlocks(text: String): List<Block> {
        val lines = text.replace(Regex("\r\n?"), "\n").split("\n")
        val blocks = mutableListOf<Block>()
        // The content column of each open list item, innermost last.
        val items = mutableListOf<Int>()
        var i = 0
        while (i < lines.size) {
            val line = lines[i]
            if (line.isBlank()) { i++; continue }
            val indent = indentOf(line)
            while (items.isNotEmpty() && indent < items.last()) items.removeAt(items.size - 1)
            val depth = items.size
            fun push(kind: BlockKind, body: String, words: String = body) { blocks.add(Block(kind, depth, null, body, words)) }
            // A fence opens at most 3 spaces in from the column its block sits at, and closes the same way.
            val base = if (depth > 0) items[depth - 1] else 0
            val rest = line.trimStart()
            val opener = if (indent - base <= 3) listOf("```", "~~~").firstOrNull { rest.startsWith(it) } else null
            if (opener != null) {
                var close = i + 1
                while (close < lines.size && !(indentOf(lines[close]) - base <= 3 && lines[close].trimStart().startsWith(opener))) close++
                if (close < lines.size) {
                    push(BlockKind.OTHER, lines.subList(i, close + 1).joinToString("\n") { dedent(it, indent) })
                    i = close + 1
                    continue
                }
            }
            val heading = PAIR_HEADING.find(line)
            if (heading != null) {
                push(BlockKind.HEADING, line.trim(), heading.groupValues[2].replace(PAIR_HEADING_CLOSE, "").trim())
                i++
                continue
            }
            if (PAIR_BREAK.containsMatchIn(line)) {
                push(BlockKind.OTHER, line.trim())
                i++
                continue
            }
            val item = PAIR_ITEM.find(line)
            if (item != null) {
                val spaces = item.groupValues[3].length
                val column = indent + item.groupValues[2].length + (if (spaces in 1..4) spaces else 1)
                val body = mutableListOf(item.groupValues[4])
                i++
                while (i < lines.size && !lines[i].isBlank() && !startsBlock(lines[i])) { body.add(dedent(lines[i], column)); i++ }
                val joined = body.joinToString("\n")
                blocks.add(Block(BlockKind.ITEM, depth, item.groupValues[2], joined, joined))
                items.add(column)
                continue
            }
            if (PAIR_QUOTE.containsMatchIn(line)) {
                val body = mutableListOf<String>()
                while (i < lines.size && PAIR_QUOTE.containsMatchIn(lines[i])) { body.add(lines[i].replaceFirst(PAIR_QUOTE_MARK, "")); i++ }
                push(BlockKind.QUOTE, body.joinToString("\n"))
                continue
            }
            if (PAIR_TABLE.containsMatchIn(line)) {
                val body = mutableListOf<String>()
                while (i < lines.size && PAIR_TABLE.containsMatchIn(lines[i])) { body.add(dedent(lines[i], indent)); i++ }
                push(BlockKind.OTHER, body.joinToString("\n"))
                continue
            }
            val body = mutableListOf(dedent(line, indent))
            i++
            while (i < lines.size && !lines[i].isBlank() && !startsBlock(lines[i])) { body.add(dedent(lines[i], indent)); i++ }
            val joined = body.joinToString("\n")
            push(if (PAIR_IMAGES.containsMatchIn(joined.trim())) BlockKind.OTHER else BlockKind.PARAGRAPH, joined)
        }
        return blocks
    }

    /**
     * "Show both languages", interleaved (docs/mocks/session-translation/03-interleaved.png): the translation's blocks with the
     * original's matched under them, or null when the two do not split into the same pairable blocks — draw the reply whole, as before
     * (frame 4). Line for line the rule of @orbit/shared `bilingualPairs` and OrbitKit `BilingualPairs.pairs`, all three walked through
     * src/shared/src/bilingual-pairs.fixture.json: blocks split by lines (fenced code, heading, list item with its continuation lines,
     * quote, table, thematic break, else paragraph); depth is how many list items a block sits inside; paragraphs, headings, items and
     * quotes pair, the rest is drawn once from the translation; the pairable sequences must match in count, kind and depth.
     */
    fun bilingualPairs(translation: String, original: String): List<BilingualPair>? {
        val ours = bilingualBlocks(translation)
        val theirs = bilingualBlocks(original).filter { it.kind != BlockKind.OTHER }
        val pairable = ours.filter { it.kind != BlockKind.OTHER }
        if (pairable.isEmpty() || pairable.size != theirs.size) return null
        if (pairable.indices.any { pairable[it].kind != theirs[it].kind || pairable[it].depth != theirs[it].depth }) return null
        var k = 0
        return ours.map { b ->
            BilingualPair(b.kind, b.depth, b.marker, b.body, if (b.kind == BlockKind.OTHER) null else theirs[k++].words)
        }
    }

    /** `GET /users/me`'s `translationAvailable`: the server holds a DeepSeek key. Absent (an older server) reads as unable. */
    fun available(user: JsonObject?): Boolean = (user?.get("translationAvailable") as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull == true

    /** `GET /users/me`'s `translationUnavailableUntil` (MeTranslation, board frame 6): until when the server skips a failing translator,
     * so a message sent now is held with reason UNAVAILABLE. Null when absent, null, unparsable or already past [now]; non-null, the
     * composer tag reads "unavailable, messages will wait". The server does not say when it passes: draw the ordinary tag again then. */
    fun unavailableUntil(user: JsonObject?, now: java.time.Instant = java.time.Instant.now()): java.time.Instant? {
        val raw = (user?.get("translationUnavailableUntil") as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
        val until = runCatching { java.time.Instant.parse(raw) }.getOrNull() ?: return null
        return until.takeIf { it.isAfter(now) }
    }

    enum class TurnState { TRANSLATING, FAILED, DONE, SENT_AS_WRITTEN }

    /** Why translating the owner's words failed (TranslationFailureReason, TRANSLATION_FAILURE_REASONS in shared's order): on a FAILED
     * turn's `failureReason` and on the 422 TRANSLATION_FAILED answer. A value this client does not know reads as no reason. */
    enum class FailureReason { TIMEOUT, NETWORK, HTTP, EMPTY, TRUNCATED, MANGLED, NO_KEY, UNAVAILABLE }

    /** A turn's `translation` (TurnTranslation): where the owner's message is, the language it was written in, and what they typed;
     * on a FAILED one, why ([failureReason]) and, beside HTTP, the translator's status ([httpStatus]). */
    data class Turn(
        val state: TurnState,
        val from: String,
        val original: String,
        val failureReason: FailureReason? = null,
        val httpStatus: Int? = null,
    ) {
        /** Not delivered to the engine yet: still translating, or failed (1A). */
        val held: Boolean get() = state == TurnState.TRANSLATING || state == TurnState.FAILED
    }

    /** A reply's `translation` (ReplyTranslation): exactly one of [text] and [failed]. */
    data class Reply(val lang: String, val text: String?, val failed: Boolean)

    fun turn(value: JsonElement?): Turn? {
        val t = value as? JsonObject ?: return null
        val original = (t["original"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return null
        val from = t.string("from")?.takeIf(::isLanguage) ?: return null
        val state = TurnState.entries.firstOrNull { it.name == t.string("state") } ?: return null
        return Turn(state, from, original, failureReason(t), httpStatus(t))
    }

    private fun failureReason(t: JsonObject): FailureReason? = FailureReason.entries.firstOrNull { it.name == t.string("failureReason") }
    private fun httpStatus(t: JsonObject): Int? = (t["httpStatus"] as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull?.toInt()

    /** Why a door refused the owner's words untranslated, read off that 422's body (TranslationFailedBody): the reason and, beside HTTP,
     * the translator's status. Null for any other error, or a refusal from a server that does not say why. */
    fun refusalReason(error: Throwable?): Pair<FailureReason, Int?>? {
        if (!refused(error)) return null
        val body = (error as io.orbitd.android.core.net.ApiError).body as? JsonObject ?: return null
        val reason = failureReason(body) ?: return null
        return reason to httpStatus(body)
    }

    fun reply(value: JsonElement?): Reply? {
        val t = value as? JsonObject ?: return null
        val lang = t.string("lang")?.takeIf(::isLanguage) ?: return null
        (t["text"] as? JsonPrimitive)?.takeIf { it.isString }?.let { return Reply(lang, it.content, false) }
        if ((t["failed"] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull == true) return Reply(lang, null, true)
        return null
    }

    /**
     * A live `translation` event (seq 0, TranslationEventPayload) folded into the event it translates, under that event's payload as
     * `translation` — exactly as a replay would have delivered it. Null when it names no event this list holds (outside the window,
     * where its replay will carry it) or is not one.
     */
    fun fold(events: List<RunEvent>, payload: JsonElement): List<RunEvent>? {
        val p = payload as? JsonObject ?: return null
        val of = (p["of"] as? JsonPrimitive)?.longOrNull ?: return null
        val translation = reply(p) ?: return null
        val at = events.indexOfFirst { it.seq == of }
        if (at < 0) return null
        val target = events[at]
        val folded = JsonObject(target.fields + ("translation" to encode(translation)))
        return events.toMutableList().also { it[at] = target.copy(payload = folded) }
    }

    private fun encode(reply: Reply): JsonObject = JsonObject(buildMap {
        put("lang", JsonPrimitive(reply.lang))
        if (reply.text != null) put("text", JsonPrimitive(reply.text)) else put("failed", JsonPrimitive(true))
    })

    /** The words a `prompt_suggestion` offers: in the owner's language once the server translated it (3A), else its own. */
    fun suggestionText(fields: JsonObject): String? =
        reply(fields["translation"])?.text?.trim()?.takeIf { it.isNotEmpty() } ?: fields.string("text")?.trim()?.takeIf { it.isNotEmpty() }

    /**
     * An approval as its card shows it (3A): `input.questions`, `input.description` and `input.plan` — and on Orbit's own cards
     * ([ORBIT_CARDS]) their title, criteria, batch tasks, goal, reason and note — in the owner's language where the server translated
     * them (ApprovalTranslation), index for index; everything else as it is. Answers are keyed by what is shown,
     * and the server maps a translated question and label back to the original before the engine reads them. A card the server could
     * not translate, or has not yet, is drawn as it came.
     */
    fun shownApproval(raw: JsonObject): JsonObject {
        val t = raw["translation"] as? JsonObject ?: return raw
        if ((t["failed"] as? JsonPrimitive)?.booleanOrNull == true) return raw
        val input = raw["input"] as? JsonObject ?: return raw
        val shown = input.toMutableMap()
        t.string("description")?.takeIf { it.isNotEmpty() && input["description"] != null }?.let { shown["description"] = JsonPrimitive(it) }
        t.string("plan")?.takeIf { it.isNotEmpty() && input["plan"] != null }?.let { shown["plan"] = JsonPrimitive(it) }
        val translated = (t["questions"] as? JsonArray)?.map { it as? JsonObject }
        val questions = input["questions"] as? JsonArray
        if (translated != null && questions != null) shown["questions"] = JsonArray(questions.mapIndexed { i, q ->
            val original = q as? JsonObject ?: return@mapIndexed q
            val tq = translated.getOrNull(i) ?: return@mapIndexed q
            val next = original.toMutableMap()
            tq.string("question")?.takeIf { it.isNotEmpty() }?.let { next["question"] = JsonPrimitive(it) }
            if (original["header"] != null) tq.string("header")?.takeIf { it.isNotEmpty() }?.let { next["header"] = JsonPrimitive(it) }
            val options = original["options"] as? JsonArray
            val tOptions = (tq["options"] as? JsonArray)?.map { it as? JsonObject }
            if (options != null && tOptions != null) next["options"] = JsonArray(options.mapIndexed { j, o ->
                val option = o as? JsonObject ?: return@mapIndexed o
                val to = tOptions.getOrNull(j) ?: return@mapIndexed o
                val shownOption = option.toMutableMap()
                to.string("label")?.takeIf { it.isNotEmpty() }?.let { shownOption["label"] = JsonPrimitive(it) }
                if (option["description"] != null) to.string("description")?.takeIf { it.isNotEmpty() }?.let { shownOption["description"] = JsonPrimitive(it) }
                JsonObject(shownOption)
            })
            JsonObject(next)
        })
        if ((raw["toolName"] as? JsonPrimitive)?.contentOrNull in ORBIT_CARDS) orbitFields(input, t, shown)
        return JsonObject(raw + ("input" to JsonObject(shown)))
    }

    /** The Orbit cards whose agent-written fields beyond `description` the server translates (TRANSLATED_ORBIT_CARDS). */
    val ORBIT_CARDS = setOf("orbit_task_create", "orbit_task_batch", "orbit_project_create", "orbit_blocker_resolve", "orbit_dag_change")

    /** An Orbit card's fields as the card draws them (ApprovalTranslation, board 04-owner-cards.html part 2): each one the original
     * has, in the owner's language where the server translated it. A batch's `tasks` go index for index with `input.tasks` and with
     * `input.preview.tasks`, whose titles the review lists. `instructions` is not drawn on Android, so it is left as it came. */
    private fun orbitFields(input: JsonObject, t: JsonObject, shown: MutableMap<String, JsonElement>) {
        fun swap(into: MutableMap<String, JsonElement>, from: JsonObject, key: String, original: JsonObject) {
            if (original[key] != null) from.string(key)?.takeIf { it.isNotEmpty() }?.let { into[key] = JsonPrimitive(it) }
        }
        fun swapped(original: JsonObject, from: JsonObject?, keys: List<String>): JsonObject {
            if (from == null) return original
            val next = original.toMutableMap()
            keys.forEach { swap(next, from, it, original) }
            return JsonObject(next)
        }
        listOf("title", "acceptanceCriteria", "goal", "reason", "note").forEach { swap(shown, t, it, input) }
        val tasks = (t["tasks"] as? JsonArray)?.map { it as? JsonObject }
        if (tasks != null) {
            (input["tasks"] as? JsonArray)?.let { originals -> shown["tasks"] = JsonArray(originals.mapIndexed { i, task ->
                (task as? JsonObject)?.let { swapped(it, tasks.getOrNull(i), listOf("title", "description", "acceptanceCriteria")) } ?: task
            }) }
            (input["preview"] as? JsonObject)?.let { preview ->
                val previewTasks = preview["tasks"] as? JsonArray ?: return@let
                shown["preview"] = JsonObject(preview + ("tasks" to JsonArray(previewTasks.mapIndexed { i, task ->
                    (task as? JsonObject)?.let { swapped(it, tasks.getOrNull(i), listOf("title")) } ?: task
                })))
            }
        }
        val items = (t["acceptanceCriteriaItems"] as? JsonArray)?.map { it as? JsonObject }
        val originals = input["acceptanceCriteriaItems"] as? JsonArray
        if (items != null && originals != null) shown["acceptanceCriteriaItems"] = JsonArray(originals.mapIndexed { i, item ->
            (item as? JsonObject)?.let { swapped(it, items.getOrNull(i), listOf("text", "verificationMethod")) } ?: item
        })
    }

    private fun JsonObject.string(key: String): String? = (get(key) as? JsonPrimitive)?.contentOrNull
}
