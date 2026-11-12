package io.orbitd.android.translation

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.compositionLocalOf
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.snapshots.SnapshotStateMap
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.dp
import io.orbitd.android.core.translation.Translation

/** Settings › Translation's words, identical on Web (`TRANSLATION_COPY`, SettingsPage's Translation card) and iOS/macOS. */
object TranslationCopy {
    // Settings › Sessions › Translation (board frames 1, 2 and 9).
    const val TITLE = "Translation"
    const val TRANSLATE_CONVERSATIONS = "Translate conversations"
    const val TRANSLATE_CONVERSATIONS_HINT = "Agents read and write in English; you write and read in your language. Your messages are translated before the agent gets them, its replies before you see them. Tool calls, output and code stay as they are."
    const val UNAVAILABLE = "This server has no DeepSeek key, so it can't translate. Whoever runs it sets DEEPSEEK_API_KEY and restarts it."
    const val YOUR_LANGUAGE = "Your language"
    const val AGENTS_WORK_IN = "Agents work in"
    const val ENGLISH = "English"
    const val FOOTER = "Translated by the server's DeepSeek model. Applies to every session from its next message; what's already in a conversation stays as it was."

    // The conversation (board frames 4–6).
    const val TRANSLATED = "Translated"
    const val SHOW_ORIGINAL = "Show original"
    const val SHOW_TRANSLATION = "Show translation"
    const val SENT_IN_ENGLISH = "Sent to the agent in English"
    const val ORIGINAL = "Original"
    const val TRANSLATING = "Translating…"
    const val SEND_FAILED = "Couldn't translate, so it wasn't sent"
    const val RETRY = "Retry"
    const val SEND_AS_WRITTEN = "Send as written"
    const val REPLY_PENDING = "Translates when the reply is done"
    const val REPLY_FAILED = "Couldn't translate this reply"
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

@Composable
fun TranslationChip(text: String) {
    Text(text, Modifier.testTag("translation-chip").clip(RoundedCornerShape(50)).background(MaterialTheme.colorScheme.surfaceVariant)
        .padding(horizontal = 8.dp, vertical = 2.dp), color = footColor(), style = MaterialTheme.typography.labelSmall)
}

/**
 * The owner's message (board frames 4–6, web `UserTranslationFoot`): "Translated · Show original" ↔ "Sent to the agent in English ·
 * Show translation" once delivered; the "Translating…" chip while held; and, held because the translation failed (1A), "Couldn't
 * translate, so it wasn't sent · Retry · Send as written". A message sent as written has no foot.
 */
@Composable
fun UserTranslationFoot(turn: Translation.Turn, flipped: Boolean, onFlip: () -> Unit, retry: (() -> Unit)?, sendAsWritten: (() -> Unit)?,
    modifier: Modifier = Modifier) {
    val muted = footColor()
    when (turn.state) {
        Translation.TurnState.TRANSLATING -> Row(modifier.testTag("translation-foot")) { TranslationChip(TranslationCopy.TRANSLATING) }
        Translation.TurnState.FAILED -> {
            val error = MaterialTheme.colorScheme.error
            Row(modifier.testTag("translation-foot"), horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(TranslationCopy.SEND_FAILED, color = error, style = MaterialTheme.typography.labelSmall)
                Sep(error); FootAction(TranslationCopy.RETRY, error, retry)
                Sep(error); FootAction(TranslationCopy.SEND_AS_WRITTEN, error, sendAsWritten)
            }
        }
        Translation.TurnState.DONE -> Row(modifier.testTag("translation-foot"), horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(if (flipped) TranslationCopy.SENT_IN_ENGLISH else TranslationCopy.TRANSLATED, color = muted, style = MaterialTheme.typography.labelSmall)
            Sep(muted); FootAction(if (flipped) TranslationCopy.SHOW_TRANSLATION else TranslationCopy.SHOW_ORIGINAL, muted, onFlip)
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
    modifier: Modifier = Modifier) {
    val muted = footColor()
    when {
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
