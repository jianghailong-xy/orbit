package io.orbitd.android.reader

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.Row
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import io.orbitd.android.composer.PendingSendCopy
import io.orbitd.android.composer.StagedAttachment

/**
 * The reader's message before the server has taken it (board docs/mocks/composer-sending-bubble/04-native-parity.html; web
 * `UserBubble`'s pending states): a local row beside the server's, since this transcript holds only theirs. Dimmed, with
 * `Sending…` under it while the request is out; then at full strength (web), with `⚠ Not sent · Retry · Put back in the composer`, and [reason] printed as one red
 * line under that foot — a touch screen has no hover for web's tooltip (owner decision 5). Its files are chips on it (decision 7).
 * [retry] and [putBack] are null while nothing may be pressed (the box not read yet).
 */
@Composable
internal fun PendingSendBubble(words: String, attachments: List<StagedAttachment>, sending: Boolean, reason: String?,
    retry: (() -> Unit)?, putBack: (() -> Unit)?, open: (String) -> Unit) {
    UserTurnColumn(Modifier.testTag(if (sending) "pending-send:sending" else "pending-send:not-sent")) {
        Box(Modifier.alpha(if (sending) DIMMED else 1f)) {
            androidx.compose.foundation.layout.Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(3.dp)) {
                SentAttachments(attachments, open)
                if (words.isNotBlank()) UserWordsBubble(words, null, open)
            }
        }
        if (sending) UserTurnMetaText(PendingSendCopy.SENDING)
        else {
            val error = MaterialTheme.colorScheme.error
            val style = MaterialTheme.typography.labelSmall
            Row(Modifier.testTag("pending-send-foot"), verticalAlignment = Alignment.CenterVertically) {
                Text("⚠ ${PendingSendCopy.NOT_SENT}", color = error, style = style, fontWeight = FontWeight.SemiBold)
                FootDot()
                FootButton(PendingSendCopy.RETRY, "pending-send:retry", retry)
                FootDot()
                FootButton(PendingSendCopy.PUT_BACK, "pending-send:put-back", putBack)
            }
            reason?.takeIf { it.isNotBlank() }?.let {
                Text(it, Modifier.testTag("pending-send-reason"), color = error, style = style, textAlign = TextAlign.End)
            }
        }
    }
}

/** What the server took, drawn as the ordinary bubble until its own row does ([io.orbitd.android.composer.SentMessage]). */
@Composable
internal fun SentBubble(words: String, attachments: List<StagedAttachment>, open: (String) -> Unit) {
    UserTurnColumn(Modifier.testTag("pending-send:sent")) {
        SentAttachments(attachments, open)
        if (words.isNotBlank()) UserWordsBubble(words, null, open)
    }
}

@Composable
private fun SentAttachments(attachments: List<StagedAttachment>, open: (String) -> Unit) {
    val shown = attachments.mapNotNull { a -> a.remoteId?.let { Triple("orbit-attachment:$it", a.name, a.mime.startsWith("image/")) } }
    UserTurnAttachments(shown.filter { it.third }.map { it.first to it.second }, shown.filterNot { it.third }.map { it.first to it.second }, open)
}

@Composable
private fun FootDot() = Text("·", Modifier.padding(horizontal = 3.dp).clearAndSetSemantics { },
    color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.labelSmall)

/** A link of the foot as the board draws it on Android: the accent, semibold, in a 12 dp pill 6 by 2 inside — no button's 58 dp
 * minimum width, which spread the foot unevenly — with a touch target of its own. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun FootButton(label: String, tag: String, press: (() -> Unit)?) =
    Text(label, Modifier.testTag(tag).minimumInteractiveComponentSize().clip(RoundedCornerShape(12.dp))
        .clickable(enabled = press != null, role = Role.Button) { press?.invoke() }.padding(horizontal = 6.dp, vertical = 2.dp),
        color = if (press != null) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
        style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.SemiBold)

/** The board's dimmed `Sending…` bubble (web `.chat-sending`). */
private const val DIMMED = 0.55f
