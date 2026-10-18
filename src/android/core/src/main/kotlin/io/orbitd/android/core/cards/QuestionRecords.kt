package io.orbitd.android.core.cards

import kotlinx.serialization.json.*

/**
 * How an agent's question (`AskUserQuestion`) ended, read back from the one record of it a client is given: the result text
 * the engine wrote for the agent. A hand copy of @orbit/shared `questionRecord.ts` and OrbitKit's `QuestionRecords` (iOS
 * 94f61b52c); `src/shared/src/question-record.fixture.json` is the set of cases all three are proved against
 * (`QuestionRecordsParityTest`), so no client reads one answer two ways.
 *
 * The answer is not kept anywhere a client reads. Orbit hands it to the engine as `updatedInput.answers`, and claude writes the
 * result from it — `The user answered: "<question>"="<answer>", …. Read the answers…`, or `Your questions have been answered: …`
 * when every answer is a pick of a multi-select question. A multi-select answer is its labels joined by a bare comma, with any
 * typed words last. "Chat about this" answers the question as a refusal whose message is the person's own words, so that result
 * is an error and its whole text is the reply.
 */
object QuestionRecords {
    /** One question's answer: the options picked, by their index in the order offered, and the words typed instead of (or, on
     * a multi-select question, beside) a listed option. */
    data class Answer(val picked: List<Int>, val typed: String?)

    /** How the questions ended: one answer per question (null where the result names none), or the reply given in the
     * conversation instead of any pick. */
    sealed interface Outcome {
        data class Answered(val answers: List<Answer?>) : Outcome
        data class Replied(val words: String) : Outcome
    }

    /** Under a reply given in the conversation instead of a pick, and over it once the card opens. */
    const val REPLIED_IN_CHAT = "Replied in chat"
    /** Over the words typed instead of a listed option, once the card opens. */
    const val YOUR_ANSWER = "Your answer"
    /** Beside a question that took several picks: the words the question card itself uses. */
    const val MULTIPLE_CHOICE = "Multiple choice"

    /** Error results that are the call failing rather than a person replying. */
    private val failurePrefixes = listOf("<tool_use_error>", "approval poll failed")
    /** The runner's refusal when no words came with it: nobody said anything. */
    private const val BARE_DENIAL = "denied by the user"

    /** The questions an AskUserQuestion call asked, read off its input as the shared reader reads them: every entry kept, in
     * order, so the answers line up with the questions the fixture names (unlike `approvalQuestions`, which drops blank ones). */
    fun questions(input: JsonElement?): List<CardQuestion> = ((input as? JsonObject)?.get("questions") as? JsonArray).orEmpty().map { q ->
        val item = q as? JsonObject ?: JsonObject(emptyMap())
        CardQuestion(item.string("question").orEmpty(), item.string("header")?.ifEmpty { null },
            (item["options"] as? JsonArray).orEmpty().map { o ->
                val option = o as? JsonObject ?: JsonObject(emptyMap())
                QuestionOption(option.string("label").orEmpty(), option.string("description")?.ifEmpty { null })
            }, (item["multiSelect"] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull == true)
    }

    /** A question's opening, for the folded card: one line of text, however the agent broke it — every run of whitespace one
     * space, the ends trimmed. By `Char.isWhitespace`, not a regex `\s`, which reads only ASCII on the JVM where JS and Swift
     * read Unicode. */
    fun lead(question: String): String = buildString {
        var gap = false
        for (ch in question) {
            if (ch.isWhitespace()) { gap = true; continue }
            if (gap && isNotEmpty()) append(' ')
            gap = false
            append(ch)
        }
    }

    /** The folded card's answer line: the picked options' labels, then any typed words in quotes, joined by " · ". Null when
     * the result names no answer to this question. */
    fun answerLine(question: CardQuestion, answer: Answer?): String? {
        answer ?: return null
        val parts = answer.picked.mapNotNull { question.options.getOrNull(it)?.label }.filter { it.isNotEmpty() }.toMutableList()
        answer.typed?.let { parts += "“$it”" }
        return parts.ifEmpty { null }?.joinToString(" · ")
    }

    /** A reply given in the conversation instead of a pick, as the folded card quotes it. */
    fun replyLine(words: String): String = "“$words”"

    /** Read how the questions ended from the call's result. Null when the result says neither — no result yet, a failure, or a
     * wording this reader does not know — and the card then shows the result as it was written. */
    fun outcome(questions: List<CardQuestion>, result: String?, isError: Boolean): Outcome? {
        val written = result.orEmpty().trim()
        if (written.isEmpty()) return null
        if (isError) {
            if (written == BARE_DENIAL || failurePrefixes.any { written.startsWith(it) }) return null
            return Outcome.Replied(written)
        }
        // Where each answer starts — right after `"<question>"="` — and where its pair does.
        val found = questions.map { q ->
            if (q.question.isEmpty()) return@map null
            val marker = "\"${q.question}\"=\""
            val at = written.indexOf(marker)
            if (at < 0) null else at to at + marker.length
        }
        val answers = questions.mapIndexed { i, q ->
            val (_, start) = found[i] ?: return@mapIndexed null
            // An answer runs to the next pair, or to the end; its closing quote is the last one before that. The sentence after
            // the last pair holds none, and neither does `, ` between pairs.
            val next = found.filterNotNull().map { it.first }.filter { it > start }.minOrNull() ?: written.length
            val close = written.lastIndexOf('"', next - 1)
            if (close < start) null else read(q, written.substring(start, close))
        }
        return if (answers.any { it != null }) Outcome.Answered(answers) else null
    }

    /** One answer's words as the picks they name and the words left over. */
    private fun read(q: CardQuestion, words: String): Answer? {
        if (words.isEmpty()) return null
        val labels = q.options.map { it.label }
        if (!q.multiSelect) {
            // One option, or the person's own words — the question card keeps the two apart.
            val at = labels.indexOf(words)
            return if (at >= 0) Answer(listOf(at), null) else Answer(emptyList(), words)
        }
        // Labels joined by commas, typed words last. A label may hold a comma itself, so each step takes the longest label the
        // rest starts with that ends where a comma or the answer does.
        val picked = mutableListOf<Int>()
        var rest = words
        while (true) {
            var best = -1
            labels.forEachIndexed { k, label ->
                if (label.isEmpty() || k in picked || !rest.startsWith(label)) return@forEachIndexed
                if (rest.length != label.length && rest[label.length] != ',') return@forEachIndexed
                if (best < 0 || label.length > labels[best].length) best = k
            }
            if (best < 0) break
            picked += best
            rest = rest.drop(labels[best].length + 1)
        }
        return Answer(picked.sorted(), rest.trim().ifEmpty { null })
    }

    private fun JsonObject.string(key: String) = (get(key) as? JsonPrimitive)?.takeIf { it.isString }?.content
}
