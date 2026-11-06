package io.orbitd.android.text

/* Markdown that reads wrongly because CJK runs straight on from it, with no space between, mended in the source before a parser
 * reads it. The parsers stay as they are, so the three clients read one rule (web `lib/cjkMarkdown.ts`, OrbitKit `mendCjkMarkdown`).
 * Never in code.
 *
 * Bold. CommonMark closes a `**` with punctuation on its inside only if whitespace or punctuation stands on its outside, and an
 * opening one mirrors that: a rule written for languages that put a space after a colon, so a CJK sentence that runs straight on
 * from a bold phrase ending in `：` reaches the reader with its stars. Moving one punctuation mark across the `**` makes it flank and
 * draws the same words: the bold just stops a mark short. Only where CJK stands at the marks, the one place this rule misfires.
 *
 * A bare URL. Autolinking takes one on through the sentence after it. Written as `<https://orbitd.io>` it ends where the address does
 * and draws the same words. An address ends at CJK punctuation, and at a CJK letter unless that letter opens a path segment, as in
 * `/wiki/中文`.
 *
 * ICU's `\s`, which the Swift matches with, is spelled out so the JVM and the device read whitespace alike. */

private const val SPACE = "\\t\\n\\f\\r\\p{Z}"
private val HOLD = Char(0xE000)
private val FENCE = Regex("^[ \\t>]*(`{3,}|~{3,})(.*?)\\r?\\z")
private val CODE_SPAN = Regex("(?<!`)(`+)(?!`).*?[^`]\\1(?!`)")

// What a mark must not be moved out of, held with the code: a link's or an image's `)`, a reference link's `]`, a tag's `>`, an
// entity's `;` and the mark an escape is for.
private val WHOLE = Regex("^[ \\t]*\\[[^\\]\\n]*\\]:[ \\t]*[^$SPACE]+|!?\\[[^\\]\\n]*\\]\\([^)\\n]*\\)|!?\\[[^\\]\\n]*\\]\\[[^\\]\\n]*\\]|<[A-Za-z/!?][^>\\n]*>|&#?[A-Za-z0-9]+;|\\\\[!-/:-@\\[-`{-~]")

private const val URL_MARK = "\\x{2010}-\\x{2027}\\x{3000}-\\x{303F}\\x{FE30}-\\x{FE4F}\\x{FF00}-\\x{FFEF}"
private const val CJK_LETTER = "\\x{2E80}-\\x{2FFF}\\x{3040}-\\x{9FFF}\\x{AC00}-\\x{D7AF}\\x{F900}-\\x{FAFF}\\x{20000}-\\x{3FFFF}"
private val BARE_URL = Regex("(?<![A-Za-z])https?://(?:[!-;=?-~]|(?<=/)[$CJK_LETTER][^$SPACE<$URL_MARK]*)+")
private val ENDS_A_URL = Regex("^[$URL_MARK$CJK_LETTER]")

// What GFM leaves off the end of a bare URL as the sentence's, not the address's.
private val URL_TAIL = Regex("[?!.,:;*_~'\"]+\\z")

// A pair read left to right, so a closing `**` is never taken for the next pair's opening one.
private val BOLD = Regex("(?<!\\*)\\*\\*(?![$SPACE*])((?:[^*]|\\*(?!\\*))+?)(?<![$SPACE])\\*\\*(?!\\*)")
private val FIRST = Regex("^\\P{M}\\p{M}*")
private val LAST = Regex("\\P{M}\\p{M}*\\z")

// What a bold phrase opens or ends on in a sentence. Never `/`, `.` or `-`, which stand beside `**` in what is not bold at all: a
// path that ends in `/**` and a power like `a**-1`.
private val SENTENCE_MARK = Regex("^(?:[:;,!?()\"'%+#\\$]|(?![\\x00-\\x7F])[\\p{P}\\p{S}])\\p{M}*\\z")

// Not whitespace, punctuation or held code. A symbol counts as a word here because cmark-gfm, the parser behind OrbitKit, reads it
// as one, and the mark moved in front of it flanks for all of them.
private val WORD = Regex("^[^$SPACE\\p{P}\\x{E000}]")
private val CJK = Regex("[\\x{2E80}-\\x{9FFF}\\x{AC00}-\\x{D7AF}\\x{F900}-\\x{FAFF}\\x{FE30}-\\x{FE4F}\\x{FF00}-\\x{FFEF}\\x{20000}-\\x{3FFFF}]")
private val SPACE_AT_AN_END = Regex("^[$SPACE]|[$SPACE]\\z")

private fun mightNeedMending(text: String) = "**" in text || "://" in text

/** The address in [url]: what is left when the sentence's marks and an unmatched `)` come off its end. */
private fun address(url: String): String {
    var kept = URL_TAIL.replace(url, "")
    while (kept.endsWith(")") && kept.count { it == ')' } > kept.count { it == '(' }) kept = URL_TAIL.replace(kept.dropLast(1), "")
    return kept
}

private fun misflanks(inside: String, outside: String) =
    SENTENCE_MARK.containsMatchIn(inside) && WORD.containsMatchIn(outside) && (CJK.containsMatchIn(inside) || CJK.containsMatchIn(outside))

private fun mendLine(line: String): String {
    val code = mutableListOf<String>()
    val holdText = { span: String -> code += span; "$HOLD${code.size - 1}$HOLD" }
    val hold = { span: MatchResult -> holdText(span.value) }
    val whole = WHOLE.replace(CODE_SPAN.replace(line, hold), hold)
    val held = BARE_URL.replace(whole) { match ->
        val url = match.value
        val kept = address(url)
        if (ENDS_A_URL.containsMatchIn(whole.substring(match.range.last + 1)) && !kept.endsWith("://")) {
            holdText("<$kept>") + url.substring(kept.length)
        } else url
    }
    var mended = BOLD.replace(held) { pair ->
        val inner = pair.groupValues[1]
        val first = FIRST.find(inner)?.value.orEmpty()
        val last = LAST.find(inner)?.value.orEmpty()
        val moveFirst = misflanks(first, LAST.find(held.substring(0, pair.range.first))?.value.orEmpty())
        val moveLast = misflanks(last, FIRST.find(held.substring(pair.range.last + 1))?.value.orEmpty())
        val from = if (moveFirst) first.length else 0
        val to = if (moveLast) inner.length - last.length else inner.length
        // Nothing left to be bold, or a space now where a mark stood: these marks would not flank either.
        if (from >= to || SPACE_AT_AN_END.containsMatchIn(inner.substring(from, to))) return@replace pair.value
        (if (moveFirst) first else "") + "**" + inner.substring(from, to) + "**" + (if (moveLast) last else "")
    }
    // Last held first: a link can hold a code span that was held before it.
    code.indices.reversed().forEach { index -> mended = mended.replace("$HOLD$index$HOLD", code[index]) }
    return mended
}

internal fun mendCjkMarkdown(markdown: String): String {
    if (!mightNeedMending(markdown)) return markdown
    var open = ""
    return markdown.split("\n").joinToString("\n") { line ->
        val found = FENCE.find(line)
        val mark = found?.groupValues?.get(1)
        val rest = found?.groupValues?.get(2).orEmpty()
        when {
            open.isNotEmpty() -> {
                if (mark != null && mark[0] == open[0] && mark.length >= open.length && rest.isBlank()) open = ""
                line
            }
            mark != null && !(mark[0] == '`' && '`' in rest) -> {
                open = mark
                line
            }
            mightNeedMending(line) -> mendLine(line)
            else -> line
        }
    }
}
