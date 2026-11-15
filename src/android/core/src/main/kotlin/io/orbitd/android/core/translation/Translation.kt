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

    /** Over this many lines a reply's English starts collapsed to a two-line preview (frame 3, B): BILINGUAL_COLLAPSE_LINES. */
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

    /** `GET /users/me`'s `translationAvailable`: the server holds a DeepSeek key. Absent (an older server) reads as unable. */
    fun available(user: JsonObject?): Boolean = (user?.get("translationAvailable") as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull == true

    enum class TurnState { TRANSLATING, FAILED, DONE, SENT_AS_WRITTEN }

    /** A turn's `translation` (TurnTranslation): where the owner's message is, the language it was written in, and what they typed. */
    data class Turn(val state: TurnState, val from: String, val original: String) {
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
        return Turn(state, from, original)
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
     * An approval as its card shows it (3A): `input.questions`, `input.description` and `input.plan` in the owner's language where
     * the server translated them (ApprovalTranslation), index for index; everything else as it is. Answers are keyed by what is shown,
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
        return JsonObject(raw + ("input" to JsonObject(shown)))
    }

    private fun JsonObject.string(key: String): String? = (get(key) as? JsonPrimitive)?.contentOrNull
}
