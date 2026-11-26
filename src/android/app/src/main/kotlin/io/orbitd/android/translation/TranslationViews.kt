package io.orbitd.android.translation

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.snapshots.SnapshotStateMap
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.BlendMode
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import io.orbitd.android.core.translation.Translation
import io.orbitd.android.management.LocalTranslation
import io.orbitd.android.text.MarkdownText

/** Settings › Translation's words, identical on Web (`TRANSLATION_COPY`, SettingsPage's Translation card) and iOS/macOS. */
object TranslationCopy {
    // Settings › Sessions › Translation (board frames 1, 2 and 9).
    const val TITLE = "Translation"
    const val TRANSLATE_CONVERSATIONS = "Translate conversations"
    /** The switch's line, naming the language agents work in by its name ("Agents work in"; web `translationEnabledDescription`). */
    fun translateConversationsHint(agentLanguage: String): String =
        "Agents read and write in ${Translation.name(agentLanguage)}; you write and read in your language. Your messages are translated before the agent gets them, its replies before you see them. Tool calls, output and code stay as they are."
    const val UNAVAILABLE = "This server has no DeepSeek key, so it can't translate. Whoever runs it sets DEEPSEEK_API_KEY and restarts it."
    const val YOUR_LANGUAGE = "Your language"
    const val AGENTS_WORK_IN = "Agents work in"
    // "Show both languages" (docs/mocks/session-translation/02-bilingual.png, marks A and B).
    const val SHOW_BOTH_LANGUAGES = "Show both languages"
    const val BILINGUAL_FOOTER = "With both languages on, each translated message also shows the words the agent read or wrote, in the language agents work in."
    const val FOOTER = "Translated by the server's DeepSeek model. Applies to every session from its next message; what's already in a conversation stays as it was."

    // The conversation (board frames 4–6).
    const val TRANSLATED = "Translated"
    const val SHOW_ORIGINAL = "Show original"
    // Both languages on, one message's original hidden and back (docs/mocks/translation-hide-original). Not SHOW_ORIGINAL, which
    // swaps the translation for the original.
    const val HIDE_ORIGINAL = "Hide original"
    const val SHOW_BOTH = "Show both"
    const val SHOW_TRANSLATION = "Show translation"
    const val ORIGINAL = "Original"
    const val TRANSLATING = "Translating…"
    const val SEND_FAILED = "Couldn't translate, so it wasn't sent"
    const val RETRY = "Retry"
    const val SEND_AS_WRITTEN = "Send as written"
    const val CANCEL = "Cancel"
    const val REPLY_PENDING = "Translates when the reply is done"
    const val REPLY_FAILED = "Couldn't translate this reply"
    // Both languages in a conversation (frames 2–4).
    const val SENT_TO_AGENT = "Sent to the agent in"
    const val SHOW = "Show"
    const val LINES = "lines"

    /** Under the owner's bilingual message: "Sent to the agent in English", naming the agent language (web `sentToAgentLabel`). */
    fun sentToAgentLabel(agentLanguage: String = Translation.DEFAULT_AGENT_LANGUAGE): String = "$SENT_TO_AGENT ${Translation.name(agentLanguage)}"

    /** The collapsed original's press (frame 3): "Show English · 9 lines", naming the agent language (web `showEnglishLabel`). */
    fun showEnglishLabel(lines: Int, agentLanguage: String = Translation.DEFAULT_AGENT_LANGUAGE): String =
        "$SHOW ${Translation.name(agentLanguage)} · $lines $LINES"
}

/**
 * Why the owner's words were not sent (policy board docs/ux/translation-failure-policy.html, frame 7's B column): the sentence before
 * "· Retry · Send as written" on a held message (4B) and, naming "your answer", on a card answer refused 422 TRANSLATION_FAILED (5).
 * No reason, or one the board has no line for (NO_KEY, HTTP without a 4xx/5xx status), is null: the drawing says today's generic [TranslationCopy.SEND_FAILED]. Same words as the web's.
 */
object TranslationFailureCopy {
    const val TIMEOUT = "The translator didn't answer in time"
    const val UNREACHABLE = "The translator was unreachable"
    const val REFUSED = "The translator refused the message"
    const val TOO_LONG = "Too long to translate"
    const val DAMAGED = "The translation came back damaged"
    const val UNAVAILABLE = "Translation is unavailable right now"
    const val MESSAGE_NOT_SENT = ", so it wasn't sent"
    const val ANSWER_NOT_SENT = ", so your answer wasn't sent"
    /** After the composer tag while the server skips a failing translator (frame 6): "Chinese → English · unavailable, messages will wait". */
    const val COMPOSER_UNAVAILABLE = "unavailable, messages will wait"

    /** The reason's clause, or null for none: HTTP 429 and 5xx were retried and read as unreachable, any other 4xx as refused, and HTTP
     *  without a status (or with one outside those) is null, like NO_KEY: frame 7 names no other, so the drawing does not guess why. */
    fun clause(reason: Translation.FailureReason?, httpStatus: Int?): String? = when (reason) {
        Translation.FailureReason.TIMEOUT -> TIMEOUT
        Translation.FailureReason.NETWORK -> UNREACHABLE
        Translation.FailureReason.HTTP -> when {
            httpStatus == null -> null
            httpStatus == 429 || httpStatus >= 500 -> UNREACHABLE
            httpStatus in 400..499 -> REFUSED
            else -> null
        }
        Translation.FailureReason.TRUNCATED -> TOO_LONG
        Translation.FailureReason.MANGLED, Translation.FailureReason.EMPTY -> DAMAGED
        Translation.FailureReason.UNAVAILABLE -> UNAVAILABLE
        Translation.FailureReason.NO_KEY, null -> null
    }

    /** A held message's line: "The translator didn't answer in time, so it wasn't sent"; null without a reason (draw SEND_FAILED). */
    fun message(reason: Translation.FailureReason?, httpStatus: Int?): String? = clause(reason, httpStatus)?.let { it + MESSAGE_NOT_SENT }

    /** A card answer's line: "The translator was unreachable, so your answer wasn't sent"; null without a reason (draw SEND_FAILED). */
    fun answer(reason: Translation.FailureReason?, httpStatus: Int?): String? = clause(reason, httpStatus)?.let { it + ANSWER_NOT_SENT }

    /** The composer tag: "Chinese → English", and while [unavailable] "Chinese → English · unavailable, messages will wait". */
    fun composerTag(language: String, agentLanguage: String, unavailable: Boolean): String =
        Translation.tag(language, agentLanguage).let { if (unavailable) "$it · $COMPOSER_UNAVAILABLE" else it }
}

/** The English under a translated message with both languages on: null draws no block (held, failed, pending, sent as written, or off). */
object BilingualShown {
    fun userEnglish(english: String, turn: Translation.Turn?, bilingual: Boolean): String? =
        if (bilingual && turn?.state == Translation.TurnState.DONE) Translation.bilingualEnglish(english).ifEmpty { null } else null

    /** A reply drawn whole under the divider: only when its blocks do not pair with its translation's ([replyPairs], frame 4). */
    fun replyEnglish(english: String, reply: Translation.Reply?, bilingual: Boolean): String? {
        val translated = reply?.text
        return if (bilingual && translated != null && Translation.bilingualPairs(translated, english) == null)
            Translation.bilingualEnglish(english).ifEmpty { null } else null
    }

    /** A reply drawn block by block, each original under its translation (03-interleaved.png); null draws it as before. */
    fun replyPairs(english: String, reply: Translation.Reply?, bilingual: Boolean): List<Translation.BilingualPair>? {
        val translated = reply?.text
        return if (bilingual && translated != null) Translation.bilingualPairs(translated, english) else null
    }

    fun collapses(english: String): Boolean = Translation.bilingualLineCount(english) > Translation.BILINGUAL_COLLAPSE_LINES
}

/** The English's `code` spans in monospace on a quiet ground, as the web and iOS draw them; the backticks go. */
internal fun inlineCode(english: String, ground: Color): AnnotatedString = buildAnnotatedString {
    var at = 0
    Regex("`([^`\n]+)`").findAll(english).forEach { m ->
        append(english.substring(at, m.range.first))
        withStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = ground)) { append(m.groupValues[1]) }
        at = m.range.last + 1
    }
    append(english.substring(at))
}

/**
 * "Show both languages", interleaved (docs/mocks/session-translation/03-interleaved.png): a reply drawn pair by pair — each block in the
 * owner's language with its original right under it, a size smaller and grey, no divider inside a pair and the usual block gap between
 * pairs. An item's original sits under its own words, indented with them; a heading's under the heading, in the regular weight. Code,
 * tables and images are drawn once, from the translation. Never collapsed.
 */
@Composable
fun InterleavedReply(pairs: List<Translation.BilingualPair>, open: (String) -> Unit, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxWidth().testTag("translation-interleaved"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        pairs.forEach { pair ->
            val indent = Modifier.padding(start = (pair.depth * 24).dp, top = if (pair.kind == Translation.BlockKind.HEADING) 4.dp else 0.dp)
            when (pair.kind) {
                // The marker drawn here, as MarkdownText draws a list's, so the original sits under the item's words.
                Translation.BlockKind.ITEM -> Row(indent) {
                    Text(pair.number?.let { "$it. " } ?: "• ", Modifier.widthIn(min = 24.dp))
                    InterleavedWords(pair, open, Modifier.weight(1f))
                }
                Translation.BlockKind.QUOTE -> Row(indent.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceVariant).padding(12.dp)) {
                    InterleavedWords(pair, open)
                }
                else -> InterleavedWords(pair, open, indent)
            }
        }
    }
}

/** One pair's words: the translated block, and its original right under it in the bilingual style. */
@Composable
private fun InterleavedWords(pair: Translation.BilingualPair, open: (String) -> Unit, modifier: Modifier = Modifier) {
    val muted = footColor()
    val code = MaterialTheme.colorScheme.surfaceVariant
    Column(modifier, verticalArrangement = Arrangement.spacedBy(2.dp)) {
        MarkdownText(pair.text, open = open)
        pair.original?.let { original ->
            Text(remember(original, code) { inlineCode(original, code) }, Modifier.testTag("translation-original"),
                color = muted, style = MaterialTheme.typography.bodySmall)
        }
    }
}

/**
 * "Show both languages" (02-bilingual.png): the English the agent read or wrote, under a dashed divider, a size smaller and grey — the
 * owner's message, and a reply whose blocks do not pair (frame 4 of 03-interleaved.png). A reply's English over [Translation.BILINGUAL_COLLAPSE_LINES] lines starts as a two-line faded preview with "Show English · N lines",
 * which opens it in place (frame 3); per message, never kept.
 */
@Composable
fun BilingualEnglish(english: String, collapsible: Boolean = false, modifier: Modifier = Modifier,
    agentLanguage: String = LocalTranslation.current.agentLanguage) {
    var open by remember(english) { mutableStateOf(false) }
    val lines = Translation.bilingualLineCount(english)
    val collapsed = collapsible && !open && lines > Translation.BILINGUAL_COLLAPSE_LINES
    val muted = footColor()
    val divider = MaterialTheme.colorScheme.outlineVariant
    Column(modifier.testTag("translation-english").padding(top = 6.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Canvas(Modifier.fillMaxWidth().height(1.dp)) {
            drawLine(divider, Offset(0f, size.height / 2), Offset(size.width, size.height / 2), strokeWidth = 1.dp.toPx(),
                pathEffect = PathEffect.dashPathEffect(floatArrayOf(3.dp.toPx(), 3.dp.toPx())))
        }
        val code = MaterialTheme.colorScheme.surfaceVariant
        Text(remember(english, code) { inlineCode(english, code) }, Modifier.testTag(if (collapsed) "translation-english-collapsed" else "translation-english-text")
            .then(if (collapsed) Modifier.graphicsLayer { alpha = 0.99f }.drawWithContent {
                drawContent()
                drawRect(Brush.verticalGradient(0.4f to Color.Black, 1f to Color.Transparent), blendMode = BlendMode.DstIn)
            } else Modifier),
            color = muted, style = MaterialTheme.typography.bodySmall, maxLines = if (collapsed) 2 else Int.MAX_VALUE)
        if (collapsed) FootAction(TranslationCopy.showEnglishLabel(lines, agentLanguage), muted) { open = true }
    }
}

/**
 * Which messages show their original, by key. Per message and never persisted: the conversation opened again shows every one
 * translated (board frame 5). Held by the reader rather than the row, so a row the list recycles keeps its side.
 */
class ShownOriginals(private val keys: SnapshotStateMap<String, Boolean> = mutableStateMapOf()) {
    fun has(key: String): Boolean = keys[key] == true
    fun toggle(key: String) { if (keys.remove(key) == null) keys[key] = true }
    companion object {
        fun user(seq: Long, turnId: String?) = "user:${turnId ?: seq}"
        fun reply(seq: Long) = "reply:$seq"
        /** Both languages on: this message's original hidden ("Hide original"). */
        fun hidden(key: String) = "hidden:$key"
    }
}

val LocalShownOriginals = compositionLocalOf<ShownOriginals?> { null }

/** What a translated message draws as its words: the owner's own (or the reply's translation), unless flipped to the English. */
object TranslationShown {
    fun userWords(english: String, turn: Translation.Turn?, flipped: Boolean): String = when {
        turn == null -> english
        turn.held -> turn.original
        turn.state == Translation.TurnState.DONE && !flipped -> turn.original
        else -> english
    }

    fun replyWords(english: String, reply: Translation.Reply?, flipped: Boolean): String =
        reply?.text?.takeIf { !flipped } ?: english
}

@Composable
private fun footColor() = MaterialTheme.colorScheme.onSurfaceVariant

@Composable
private fun Sep(color: Color) = Text("·", color = color, style = MaterialTheme.typography.labelSmall)

@Composable
private fun FootAction(label: String, color: Color, onPress: (() -> Unit)?) {
    Text(label, Modifier.testTag("translation-action:$label").then(if (onPress != null) Modifier.clickable(role = Role.Button, onClick = onPress) else Modifier),
        color = color, style = MaterialTheme.typography.labelSmall, textDecoration = TextDecoration.Underline)
}

/**
 * One of Orbit's own cards drawn in the owner's language (board 04-owner-cards.html, part 2): one foot for the whole card, as a reply's,
 * "Translated · Show original" ↔ "Original · Show translation".
 */
@Composable
fun CardTranslationFoot(flipped: Boolean, onFlip: () -> Unit, modifier: Modifier = Modifier) {
    val muted = footColor()
    Row(modifier.testTag("translation-foot"), horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(if (flipped) TranslationCopy.ORIGINAL else TranslationCopy.TRANSLATED, color = muted, style = MaterialTheme.typography.labelSmall)
        Sep(muted); FootAction(if (flipped) TranslationCopy.SHOW_TRANSLATION else TranslationCopy.SHOW_ORIGINAL, muted, onFlip)
    }
}

/**
 * An owner card's answer the server could not translate (422 TRANSLATION_FAILED, board 04-owner-cards.html mark B): nothing was
 * recorded, and the card says why ([TranslationFailureCopy.answer], policy board frame 5: "The translator was unreachable, so your
 * answer wasn't sent"), or without a reason "Couldn't translate, so it wasn't sent", then "· Retry · Send as written".
 * Send as written sends the words again untranslated (`sendAsWritten: true`).
 */
@Composable
fun AnswerNotTranslated(retry: () -> Unit, sendAsWritten: () -> Unit, enabled: Boolean, modifier: Modifier = Modifier,
    reason: Translation.FailureReason? = null, httpStatus: Int? = null) {
    val error = MaterialTheme.colorScheme.error
    Row(modifier.testTag("card-translation-failed"), verticalAlignment = Alignment.CenterVertically) {
        Text(TranslationFailureCopy.answer(reason, httpStatus) ?: TranslationCopy.SEND_FAILED, Modifier.weight(1f, fill = false), color = error, style = MaterialTheme.typography.bodySmall)
        Sep(error)
        androidx.compose.material3.TextButton(onClick = retry, enabled = enabled) { Text(TranslationCopy.RETRY) }
        Sep(error)
        androidx.compose.material3.TextButton(onClick = sendAsWritten, enabled = enabled) { Text(TranslationCopy.SEND_AS_WRITTEN) }
    }
}

/** Both languages on: " · Hide original", or " · Show both" once this message's original is hidden (docs/mocks/translation-hide-original). */
@Composable
private fun HideOriginal(hidden: Boolean, onPress: (() -> Unit)?, color: Color) {
    if (onPress == null) return
    Sep(color); FootAction(if (hidden) TranslationCopy.SHOW_BOTH else TranslationCopy.HIDE_ORIGINAL, color, onPress)
}

@Composable
fun TranslationChip(text: String) {
    Text(text, Modifier.testTag("translation-chip").clip(RoundedCornerShape(50)).background(MaterialTheme.colorScheme.surfaceVariant)
        .padding(horizontal = 8.dp, vertical = 2.dp), color = footColor(), style = MaterialTheme.typography.labelSmall)
}

/**
 * The owner's message (board frames 4–6, web `UserTranslationFoot`): "Show original" ↔ "Show translation" once delivered, the press
 * alone (docs/mocks/translation-foot-one-line, B); the "Translating…" chip while held; and, held because the translation failed (1A), why
 * ([TranslationFailureCopy.message], e.g. "The translator didn't answer in time, so it wasn't sent") · Retry · Send as written · Cancel
 * (only where [cancel] can withdraw it). A message sent as written has no foot.
 */
@Composable
fun UserTranslationFoot(turn: Translation.Turn, flipped: Boolean, onFlip: () -> Unit, retry: (() -> Unit)?, sendAsWritten: (() -> Unit)?,
    modifier: Modifier = Modifier, bilingual: Boolean = false, originalHidden: Boolean = false, onHideOriginal: (() -> Unit)? = null, cancel: (() -> Unit)? = null) {
    val muted = footColor()
    // Both languages on: the English is in the message, so there is nothing to flip to (mark C); "Hide original" hides it.
    if (bilingual && turn.state == Translation.TurnState.DONE) {
        Row(modifier.testTag("translation-foot"), horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(TranslationCopy.sentToAgentLabel(LocalTranslation.current.agentLanguage), color = muted, style = MaterialTheme.typography.labelSmall)
            HideOriginal(originalHidden, onHideOriginal, muted)
        }
        return
    }
    when (turn.state) {
        Translation.TurnState.TRANSLATING -> Row(modifier.testTag("translation-foot")) { TranslationChip(TranslationCopy.TRANSLATING) }
        Translation.TurnState.FAILED -> {
            val error = MaterialTheme.colorScheme.error
            Row(modifier.testTag("translation-foot"), horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                // The reason's sentence wraps on a narrow phone; the presses keep their width beside it.
                Text(TranslationFailureCopy.message(turn.failureReason, turn.httpStatus) ?: TranslationCopy.SEND_FAILED, Modifier.weight(1f, fill = false),
                    color = error, style = MaterialTheme.typography.labelSmall)
                Sep(error); FootAction(TranslationCopy.RETRY, error, retry)
                Sep(error); FootAction(TranslationCopy.SEND_AS_WRITTEN, error, sendAsWritten)
                cancel?.let { Sep(error); FootAction(TranslationCopy.CANCEL, error, it) }
            }
        }
        Translation.TurnState.DONE -> Row(modifier.testTag("translation-foot"), verticalAlignment = Alignment.CenterVertically) {
            FootAction(if (flipped) TranslationCopy.SHOW_TRANSLATION else TranslationCopy.SHOW_ORIGINAL, muted, onFlip)
        }
        Translation.TurnState.SENT_AS_WRITTEN -> Unit
    }
}

/**
 * An agent reply (board frames 5–6, web `ReplyTranslationFoot`): "Translated · Show original" ↔ "Original · Show translation"; failed
 * (2A), "Couldn't translate this reply · Retry"; still to be translated ([pending]), the chip "Translates when the reply is done".
 */
@Composable
fun ReplyTranslationFoot(reply: Translation.Reply?, pending: Boolean, flipped: Boolean, onFlip: () -> Unit, retry: (() -> Unit)?,
    modifier: Modifier = Modifier, bilingual: Boolean = false, originalHidden: Boolean = false, onHideOriginal: (() -> Unit)? = null) {
    val muted = footColor()
    when {
        bilingual && reply?.text != null -> Row(modifier.testTag("translation-foot"), horizontalArrangement = Arrangement.spacedBy(4.dp),
            verticalAlignment = Alignment.CenterVertically) {
            Text(TranslationCopy.TRANSLATED, color = muted, style = MaterialTheme.typography.labelSmall)
            HideOriginal(originalHidden, onHideOriginal, muted)
        }
        reply?.failed == true -> {
            val error = MaterialTheme.colorScheme.error
            Row(modifier.testTag("translation-foot"), horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(TranslationCopy.REPLY_FAILED, color = error, style = MaterialTheme.typography.labelSmall)
                Sep(error); FootAction(TranslationCopy.RETRY, error, retry)
            }
        }
        reply?.text != null -> Row(modifier.testTag("translation-foot"), horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(if (flipped) TranslationCopy.ORIGINAL else TranslationCopy.TRANSLATED, color = muted, style = MaterialTheme.typography.labelSmall)
            Sep(muted); FootAction(if (flipped) TranslationCopy.SHOW_TRANSLATION else TranslationCopy.SHOW_ORIGINAL, muted, onFlip)
        }
        pending -> Row(modifier.testTag("translation-foot")) { TranslationChip(TranslationCopy.REPLY_PENDING) }
    }
}
